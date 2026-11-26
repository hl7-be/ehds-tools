// ---------------------------------------------------------------------------
// StructureDefinition -> UML class diagram (PlantUML).
//
// Unlike the modelgram view (one box, an indented tree), every element that has
// children becomes its own class, linked to its parent by composition with the
// element's cardinality. Leaf elements are attributes `name : Type [min..max]`.
// Elements typed with another logical model or a Reference get an association
// to that type, drawn as a separate (empty) class.
// ---------------------------------------------------------------------------

import { STAGE_COLORS } from './modelgram.js';

const PRIMITIVES = new Set([
  'boolean', 'integer', 'integer64', 'decimal', 'string', 'markdown', 'code', 'id', 'uri', 'url', 'canonical', 'oid',
  'uuid', 'date', 'dateTime', 'instant', 'time', 'base64Binary', 'positiveInt', 'unsignedInt', 'xhtml',
]);
// Common FHIR datatypes stay attributes; drawing them as classes only adds noise.
const DATATYPES = new Set([
  'CodeableConcept', 'Coding', 'Identifier', 'Period', 'Quantity', 'Range', 'Ratio', 'Attachment', 'HumanName',
  'Address', 'ContactPoint', 'Annotation', 'Timing', 'Duration', 'Age', 'Money', 'SimpleQuantity', 'SampledData',
  'Signature', 'Expression', 'CodeableReference', 'BackboneElement', 'Element', 'Base', 'Meta', 'Narrative',
]);

export function fhirToUml(sd, { view = 'snapshot', bg = STAGE_COLORS.published, associations = true } = {}) {
  if (!sd?.name) throw new Error("StructureDefinition must have a 'name'.");
  const raw = (view === 'snapshot' ? sd.snapshot?.element : sd.differential?.element) ?? sd.snapshot?.element ?? sd.differential?.element ?? [];
  if (!raw.length) throw new Error('StructureDefinition has neither differential nor snapshot elements.');

  // index by id, skipping slicing entries without a name; keep the root
  const elements = raw.filter((e) => !(e.slicing && !e.sliceName));
  const rootPath = elements[0].path.split('.')[0];
  const ids = elements.map((e) => e.id ?? e.path);
  const hasChildren = new Set();
  for (const id of ids) {
    const parent = parentId(id);
    if (parent) hasChildren.add(parent);
  }

  const classes = new Map(); // id -> { name, attrs: [] }
  const links = [];
  const external = new Set();

  classes.set(ids[0], { name: sd.name, title: sd.title ?? sd.name, attrs: [], root: true });

  elements.forEach((el, i) => {
    const id = ids[i];
    if (i === 0) return;
    const parent = parentId(id);
    const owner = classes.get(parent) ?? classes.get(ids[0]);
    const name = lastSegment(id);
    const card = `${el.min ?? 0}..${el.max ?? '*'}`;
    const types = (el.type ?? []).map(typeName);

    if (hasChildren.has(id)) {
      const className = `${classes.get(parent)?.name ?? sd.name}.${name}`;
      classes.set(id, { name: className, title: capitalise(name), attrs: [] });
      links.push({ from: parent, to: id, kind: 'composition', label: name, card });
      return;
    }

    // an element typed with another model is an association, not also an attribute
    const targets = associations ? (el.type ?? []).flatMap(associationTargets) : [];
    if (!targets.length) {
      owner.attrs.push(`${name} : ${types.join(' | ') || '?'} [${card}]`);
      return;
    }
    for (const target of new Set(targets)) {
      external.add(target);
      links.push({ from: classes.has(parent) ? parent : ids[0], toExternal: target, kind: 'association', label: name, card });
    }
  });

  const alias = (id) => umlId(`c_${id}`);
  const lines = [
    '@startuml',
    `skinparam ClassBackgroundColor ${bg}`,
    'skinparam linetype ortho',
    'skinparam shadowing false',
    'skinparam ClassAttributeIconSize 0',
    'hide circle',
    'hide methods',
    'hide stereotype',
    'left to right direction',
    '',
  ];
  for (const [id, c] of classes) {
    lines.push(`class "${c.root ? `**${c.title}**` : c.title}" as ${alias(id)} {`);
    for (const a of c.attrs) lines.push(`  ${a}`);
    lines.push('}');
  }
  for (const t of external) {
    lines.push(`class "${t}" as ${umlId(`x_${t}`)} #FFFFFF {`, '}');
  }
  lines.push('');
  for (const l of links) {
    const to = l.toExternal ? umlId(`x_${l.toExternal}`) : alias(l.to);
    const arrow = l.kind === 'composition' ? '*--' : '-->';
    lines.push(`${alias(l.from)} "${l.kind === 'composition' ? '1' : ''}" ${arrow} "${l.card}" ${to} : ${l.label}`.replace(' "" ', ' '));
  }
  lines.push('@enduml');
  return lines.join('\n');
}

/** Types worth an association: Reference targets and other models (not primitives or common datatypes). */
function associationTargets(t) {
  const code = lastSegment(String(t.code));
  if (code === 'Reference' && t.targetProfile?.length) return t.targetProfile.map(lastSegment);
  if (code === 'Reference' || code === 'CodeableReference') return (t.targetProfile ?? []).map(lastSegment);
  if (PRIMITIVES.has(code) || DATATYPES.has(code)) return [];
  return [code];
}

function typeName(t) {
  const code = lastSegment(String(t.code));
  if ((code === 'Reference' || code === 'CodeableReference') && t.targetProfile?.length) {
    return `${code}(${t.targetProfile.map(lastSegment).join(' | ')})`;
  }
  return code;
}

/** Parent id: "A.b:slice.c" -> "A.b:slice"; the root has none. */
function parentId(id) {
  const i = id.lastIndexOf('.');
  return i < 0 ? null : id.slice(0, i);
}

function lastSegment(s) {
  const parts = String(s).split(/[./]/);
  return parts[parts.length - 1];
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function umlId(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}
