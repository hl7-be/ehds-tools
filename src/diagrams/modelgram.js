// Copied from CareSetsOverview (server/lib/fhir2puml.js) so the diagrams match the CareSets tool.
// ---------------------------------------------------------------------------
// FHIR Logical Model (StructureDefinition) -> PlantUML
//
// Port of medigree/modelgram's fhirToPlantUML so diagrams here match the ones
// produced by https://medigree.github.io/modelgram/ . The only addition is
// status-driven class background colour (see STATUS_COLORS).
// ---------------------------------------------------------------------------

// Pale, non-flashy fills, keyed by lifecycle stage. Everything before
// publication is yellow, published is modelgram's own default blue (so a
// published model renders identically to the reference tool), retired orange.
export const STAGE_COLORS = {
  draft: "#F7EFB5", // pale yellow
  review: "#F7EFB5",
  reviewed: "#F7EFB5",
  accepted: "#F7EFB5",
  published: "#B5E8F7", // pale blue
  deprecated: "#F7D6B5", // pale orange
  unknown: "#E6E6E6", // pale grey
};

export const DEFAULT_OPTIONS = {
  view: "differential", // 'differential' | 'snapshot'
  datatypes: false,
  denormalize: false,
  iso11179: false,
  bg: STAGE_COLORS.published,
};

export function stageColor(stage) {
  return STAGE_COLORS[stage] || STAGE_COLORS.unknown;
}

/** Which view can this StructureDefinition actually render? */
export function availableViews(sd) {
  const views = [];
  if (sd?.differential?.element?.length) views.push("differential");
  if (sd?.snapshot?.element?.length) views.push("snapshot");
  return views;
}

export function fhirToPlantUML(fhirJson, userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };

  if (!fhirJson || !fhirJson.name) {
    throw new Error("StructureDefinition must have a 'name'.");
  }
  // Fall back to whatever view the resource actually carries.
  const views = availableViews(fhirJson);
  if (!views.length) {
    throw new Error("StructureDefinition has neither differential nor snapshot elements.");
  }
  const view = views.includes(options.view) ? options.view : views[0];

  // Resolve base type name from baseDefinition URL
  let baseName = "";
  if (fhirJson.baseDefinition) {
    const segments = fhirJson.baseDefinition.split("/");
    baseName = segments[segments.length - 1];
  }

  let classTitle = `**${fhirJson.name}**`;
  if (view === "differential" && baseName && baseName !== "Base" && baseName !== "Element") {
    classTitle += options.datatypes ? ` : ${baseName}` : ` (${baseName})`;
  }

  const safeName = umlIdentifier(fhirJson.name);

  const lines = [
    "@startuml",
    `skinparam ClassBackgroundColor ${options.bg || DEFAULT_OPTIONS.bg}`,
    "skinparam linetype polyline",
    "hide circle",
    options.iso11179 ? "" : "hide stereotype",
    "",
    options.iso11179
      ? `class "${classTitle}" as ${safeName} <<ObjectClass>> {`
      : `class "${classTitle}" as ${safeName} {`,
  ];

  // In snapshot view, elements also present in the differential are the ones
  // this model actually constrains -> bold. Inherited ones -> italic.
  const diffPaths = new Set();
  if (view === "snapshot" && fhirJson.differential?.element) {
    const diffElements = options.denormalize
      ? denormalizeElements(fhirJson.differential.element)
      : fhirJson.differential.element;
    for (const el of diffElements) diffPaths.add(el.path);
  }

  const rawElements =
    view === "snapshot" ? fhirJson.snapshot.element : fhirJson.differential.element;
  const elements = options.denormalize ? denormalizeElements(rawElements) : rawElements;

  for (const el of elements) {
    const parts = el.path.split(".");
    if (parts.length <= 1) continue;

    const indent = "  ".repeat(parts.length - 1);
    const name = parts[parts.length - 1];
    const card = `${el.min ?? 0}..${el.max ?? "*"}`;

    let typeSuffix = "";
    if (options.datatypes && el.type?.length) {
      const codes = el.type.map(resolveTypeName).join(" | ");
      typeSuffix = `   <<${codes}>>`;
    }

    // Two trailing spaces give the class box a little breathing room on the
    // right, which PlantUML otherwise crops tight against the longest line.
    const pad = "  ";

    const inherited = view === "snapshot" && !diffPaths.has(el.path);
    if (inherited) {
      lines.push(`${indent}|_ //${name}// ${card}${typeSuffix}${pad}`);
    } else if (view === "snapshot") {
      lines.push(`${indent}|_ **${name}** ${card}${typeSuffix}${pad}`);
    } else {
      lines.push(`${indent}|_ ${name} ${card}${typeSuffix}${pad}`);
    }
  }

  lines.push("}");
  lines.push("@enduml");
  return lines.join("\n");
}

// PlantUML aliases must not contain spaces or punctuation.
function umlIdentifier(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

// ---- Type name resolution -------------------------------------------------

export function resolveTypeName(typeObj) {
  let code = typeObj.code;

  // FHIR logical models express primitives as full URLs -> use the last segment.
  if (code && (code.startsWith("http://") || code.startsWith("https://"))) {
    code = code.split("/").pop();
  }

  if (code === "Reference" && typeObj.targetProfile?.length) {
    const targets = typeObj.targetProfile.map((url) => url.split("/").pop());
    return `Reference(${targets.join(" | ")})`;
  }

  return code;
}

// ---- openEHR denormalization ----------------------------------------------
// Flattens openEHR-style sliced "items"/"value" chains into normal elements.

export function denormalizeElements(elements) {
  const result = [];
  let i = 0;

  while (i < elements.length) {
    const el = elements[i];
    const lastPart = el.path.split(".").pop();

    // Slicing definitions themselves carry no content.
    if (el.slicing && !el.sliceName) {
      i++;
      continue;
    }

    if (el.sliceName && lastPart === "items") {
      i = emitDenormalizedSlice(elements, i, el.path.split(".").slice(0, -1).join("."), result);
      continue;
    }

    result.push(el);
    i++;
  }

  return result;
}

function emitDenormalizedSlice(elements, i, parentPath, result) {
  const el = elements[i];
  const slicePath = el.path;
  const displayName = (el.short || el.sliceName).replace(/\s+/g, " ");
  const newPath = `${parentPath}.${displayName}`;

  const valueTypes = [];
  let j = i + 1;

  while (j < elements.length) {
    const child = elements[j];

    if (child.path === slicePath && child.sliceName) break; // next sibling slice
    if (!child.path.startsWith(`${slicePath}.`) && child.path !== slicePath) break; // out of scope

    if (child.slicing && !child.sliceName) {
      j++;
      continue;
    }

    if (child.sliceName && child.path.split(".").pop() === "items") {
      j = emitDenormalizedSlice(elements, j, newPath, result);
      continue;
    }

    if (child.path === `${slicePath}.value` && child.type?.length) {
      valueTypes.push(...child.type);
    }

    j++;
  }

  const deduped = deduplicateTypes(valueTypes);
  result.push({
    path: newPath,
    min: el.min ?? 0,
    max: el.max || "*",
    type: deduped.length ? deduped : el.type,
  });

  return j;
}

function deduplicateTypes(types) {
  const unique = [];
  const seen = new Set();
  for (const t of types) {
    const name = resolveTypeName(t);
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(t);
    }
  }
  return unique;
}
