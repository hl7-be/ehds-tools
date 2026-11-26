import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { modelElements } from './catalog.js';

/**
 * Mappings from the EHDS models (or profiles) to the Belgian ones are FHIR ConceptMaps
 * (JSON, R5; R4 `equivalence`/`sourceUri` are also read), one per pair:
 *
 *   sourceScopeCanonical   EHDS model url|version it was made against
 *   targetScopeCanonical   Belgian model url|version it was made against
 *   date                   when the mapping was last changed
 *   group.source/.target   the two model urls
 *   group.element.code     EHDS element id (e.g. EHDSPatient.name.family)
 *   element.target.code    Belgian element id; relationship as usual
 *   element.target.comment the remark on that mapping line
 *   element.noMap = true   no Belgian equivalent (with a remark: target without code,
 *                          relationship not-related-to, with a comment)
 *   element without target and without noMap: still to be mapped
 */

/** Read every ConceptMap (*.json) under dir, recursively. Missing dir = no mappings. */
export async function loadMappings(dir) {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const maps = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    const res = parseConceptMap(await readFile(file, 'utf8'), file);
    if (res) maps.push({ file: path.relative(dir, file).split(path.sep).join('/'), resource: res });
  }
  return maps.sort((a, b) => a.file.localeCompare(b.file));
}

export function parseConceptMap(text, file = 'ConceptMap') {
  let res;
  try {
    res = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${err.message})`);
  }
  return res?.resourceType === 'ConceptMap' ? res : null;
}

/** "url|version" -> { url, version } */
export function splitCanonical(c) {
  if (!c) return { url: null, version: null };
  const i = c.indexOf('|');
  return i < 0 ? { url: c, version: null } : { url: c.slice(0, i), version: c.slice(i + 1) };
}

/** Flatten ConceptMaps into one entry per group, with one line per element. */
export function mappingGroups(maps) {
  const groups = [];
  for (const { file, resource: cm } of maps) {
    const sourceScope = splitCanonical(cm.sourceScopeCanonical ?? cm.sourceCanonical ?? cm.sourceScopeUri ?? cm.sourceUri);
    const targetScope = splitCanonical(cm.targetScopeCanonical ?? cm.targetCanonical ?? cm.targetScopeUri ?? cm.targetUri);
    for (const g of cm.group ?? []) {
      const source = splitCanonical(g.source);
      const target = splitCanonical(g.target);
      groups.push({
        file,
        conceptMap: { id: cm.id, url: cm.url ?? null, title: cm.title ?? cm.name ?? cm.id, status: cm.status ?? null, date: cm.date ?? null },
        source: source.url ?? sourceScope.url,
        target: target.url ?? targetScope.url,
        // the model versions this mapping was made against
        sourceVersion: source.version ?? sourceScope.version,
        targetVersion: target.version ?? targetScope.version,
        elements: (g.element ?? []).map(lineOf),
      });
    }
  }
  return groups;
}

function lineOf(el) {
  const targets = (el.target ?? []).map((t) => ({
    code: t.code ?? null,
    display: t.display ?? null,
    relationship: t.relationship ?? t.equivalence ?? null,
    comment: t.comment ?? null,
  }));
  let status;
  if (targets.some((t) => t.code)) status = 'mapped';
  else if (el.noMap || targets.length > 0) status = 'no-map';
  else status = 'open';
  return { code: el.code, display: el.display ?? null, status, targets };
}

/**
 * A ConceptMap with every element of an EHDS model listed and nothing mapped yet.
 * source/target: { sd, entry } - the StructureDefinition and its catalog entry (target may be a bare url).
 */
export function scaffoldConceptMap({ source, target, canonical, date = new Date().toISOString() }) {
  const sd = source.sd;
  const targetUrl = target.entry?.url ?? target.url;
  const targetName = target.entry?.name ?? lastSegment(targetUrl);
  const id = `${sd.id}-to-${targetName}`.replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64);
  const versioned = (url, version) => (version ? `${url}|${version}` : url);
  return {
    resourceType: 'ConceptMap',
    id,
    url: `${canonical.replace(/\/$/, '')}/${id}`,
    name: id.replace(/[^A-Za-z0-9]/g, ''),
    title: `${sd.title ?? sd.name} to ${target.entry?.title ?? targetName}`,
    status: 'draft',
    date,
    sourceScopeCanonical: versioned(sd.url, source.entry?.version ?? sd.version),
    targetScopeCanonical: versioned(targetUrl, target.entry?.version),
    group: [
      {
        source: sd.url,
        target: targetUrl,
        element: modelElements(sd).map((e) => ({ code: e.id, display: e.short ?? undefined })),
      },
    ],
  };
}

function lastSegment(url) {
  return String(url).replace(/\/$/, '').split('/').pop();
}
