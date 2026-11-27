import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { modelElements } from './catalog.js';

/**
 * Mappings written as CSV, as in the CareSets IGs - one file per EHDS model and Belgian model:
 *
 *   mappings/<EHDSModel>--<BeModel>.csv
 *   sourceCode, sourceDisplay, relationship, targetCode, targetDisplay, comment
 *
 *   relationship  R4 ConceptMap equivalence: equivalent, equal, wider, subsumes, narrower,
 *                 specializes, inexact, relatedto = mapped (targetCode required);
 *                 unmatched = no Belgian equivalent (no targetCode); empty = still open
 *   comment       the remark on that line
 *
 * Each CSV is turned into an R4 ConceptMap, mappings/generated/ConceptMap-<pair>.json, which
 * records the model versions the mapping was made against (kept until --remap) and the date
 * its content last changed. The site, the comparison and the progress chart read those.
 */
export const COLUMNS = ['sourceCode', 'sourceDisplay', 'relationship', 'targetCode', 'targetDisplay', 'comment'];
export const MAPPED = ['equivalent', 'equal', 'wider', 'subsumes', 'narrower', 'specializes', 'inexact', 'relatedto'];
export const NO_MAP = ['unmatched'];
export const GENERATED_DIR = 'generated';
// a comment on a line that is still open (R4 has no element comment)
export const OPEN_COMMENT_URL = 'https://github.com/hl7-be/ehds-tools/StructureDefinition/open-line-comment';

// ---------------------------------------------------------------- CSV

/** RFC 4180: quotes, doubled quotes, commas and line breaks inside quotes, CRLF, BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** The rows of a mapping CSV as objects, with the format problems found. */
export function readMappingCsv(text, file = 'mapping.csv') {
  const [header, ...lines] = parseCsv(text);
  const errors = [];
  const cols = (header ?? []).map((h) => h.trim());
  const missing = COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length) {
    errors.push(`${file}: missing column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (expected ${COLUMNS.join(', ')})`);
    return { rows: [], errors };
  }
  const rows = lines.map((l, i) => {
    const r = Object.fromEntries(COLUMNS.map((c) => [c, (l[cols.indexOf(c)] ?? '').trim()]));
    r.line = i + 2;
    return r;
  });
  for (const r of rows) {
    const at = `${file}:${r.line}`;
    const rel = r.relationship.toLowerCase();
    if (!r.sourceCode) errors.push(`${at}: sourceCode is empty`);
    if (rel && !MAPPED.includes(rel) && !NO_MAP.includes(rel)) errors.push(`${at}: relationship "${r.relationship}" is not one of ${[...MAPPED, ...NO_MAP].join(', ')} (or empty = open)`);
    if (MAPPED.includes(rel) && !r.targetCode) errors.push(`${at}: ${rel} without a targetCode (use unmatched when there is no Belgian equivalent)`);
    if (NO_MAP.includes(rel) && r.targetCode) errors.push(`${at}: unmatched with a targetCode`);
    if (!rel && r.targetCode) errors.push(`${at}: targetCode without a relationship`);
  }
  const bySource = new Map();
  for (const r of rows) bySource.set(r.sourceCode, [...(bySource.get(r.sourceCode) ?? []), r]);
  for (const [code, rs] of bySource) {
    const kinds = new Set(rs.map((r) => (MAPPED.includes(r.relationship.toLowerCase()) ? 'mapped' : r.relationship ? 'no-map' : 'open')));
    if (rs.length > 1 && kinds.size > 1) errors.push(`${file}: ${code} is on lines ${rs.map((r) => r.line).join(', ')} with different kinds (${[...kinds].join(', ')}) - several rows are for several targets`);
    const seen = new Set();
    for (const r of rs) {
      const key = `${r.relationship}|${r.targetCode}`;
      if (seen.has(key)) errors.push(`${file}:${r.line}: ${code} -> ${r.targetCode || '(none)'} is repeated`);
      seen.add(key);
    }
  }
  return { rows, errors };
}

/** "EHDSCondition--BeModelProblem.csv" -> { source, target } */
export function pairOf(file) {
  const base = path.basename(file).replace(/\.csv$/i, '');
  const i = base.indexOf('--');
  return i < 0 ? null : { source: base.slice(0, i), target: base.slice(i + 2) };
}

export const generatedName = (csvFile) => `ConceptMap-${path.basename(csvFile).replace(/\.csv$/i, '')}.json`;

// ---------------------------------------------------------------- ConceptMap

/**
 * The R4 ConceptMap of a mapping CSV.
 *   source / target  { url, version, name, title } of the two models
 *   previous         the ConceptMap generated before: its versions and date are kept, unless remap
 */
export function conceptMapFromCsv({ file, rows, source, target, canonical, previous = null, remap = false, now = new Date().toISOString() }) {
  const pair = pairOf(file);
  const id = path.basename(file).replace(/\.csv$/i, '').replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64);
  const prevSource = previous ? splitVersion(previous.sourceCanonical) : null;
  const prevTarget = previous ? splitVersion(previous.targetCanonical) : null;
  const sourceVersion = remap || !previous ? source.version ?? null : prevSource.version;
  const targetVersion = remap || !previous ? target.version ?? null : prevTarget.version;
  // once generated, the urls are those of the previous ConceptMap: the result depends only on the
  // CSV and that file, so "maps --check" gives the same answer with or without the models fetched
  const sourceUrl = remap || !previous ? source.url ?? prevSource?.url : prevSource.url;
  const targetUrl = remap || !previous ? target.url ?? prevTarget?.url : prevTarget.url;

  const elements = [];
  for (const r of rows) {
    let el = elements.find((e) => e.code === r.sourceCode);
    if (!el) {
      el = { code: r.sourceCode, ...(r.sourceDisplay ? { display: r.sourceDisplay } : {}) };
      elements.push(el);
    }
    const rel = r.relationship.toLowerCase();
    if (!rel) {
      if (r.comment) el.extension = [{ url: OPEN_COMMENT_URL, valueString: r.comment }];
      continue;
    }
    (el.target ??= []).push({
      ...(r.targetCode ? { code: r.targetCode } : {}),
      ...(r.targetDisplay ? { display: r.targetDisplay } : {}),
      equivalence: rel,
      ...(r.comment ? { comment: r.comment } : {}),
    });
  }

  const cm = {
    resourceType: 'ConceptMap',
    id,
    url: `${canonical.replace(/\/$/, '')}/${id}`,
    name: id.replace(/[^A-Za-z0-9]/g, ''),
    title: `${pair?.source ?? source.name} to ${pair?.target ?? target.name}`,
    status: 'draft',
    date: null,
    description: `Generated from mappings/${path.basename(file)} - edit the CSV and run "ehds-tools maps".`,
    sourceCanonical: versioned(sourceUrl, sourceVersion),
    targetCanonical: versioned(targetUrl, targetVersion),
    group: [
      {
        source: sourceUrl,
        ...(sourceVersion ? { sourceVersion } : {}),
        target: targetUrl,
        ...(targetVersion ? { targetVersion } : {}),
        element: elements,
      },
    ],
  };
  // the date moves only when the content changes
  cm.date = previous && sameContent(previous, cm) ? previous.date : now;
  return cm;
}

function sameContent(a, b) {
  const strip = (x) => JSON.stringify({ ...x, date: null });
  return strip(a) === strip(b);
}

const versioned = (url, version) => (version ? `${url}|${version}` : url);

function splitVersion(c) {
  if (!c) return { url: null, version: null };
  const i = c.indexOf('|');
  return i < 0 ? { url: c, version: null } : { url: c.slice(0, i), version: c.slice(i + 1) };
}

/** A new mapping CSV: one open row per EHDS element, with its short description. */
export function scaffoldCsv(sd) {
  return toCsv([COLUMNS, ...modelElements(sd).map((e) => [e.id, e.short ?? '', '', '', '', ''])]);
}

// ---------------------------------------------------------------- run

/**
 * Generate (or check) the ConceptMap of every CSV in the mappings directory.
 *   models   catalog entries (both sides) to find the models by name; with their SDs (optional)
 *            to check the element codes
 *   check    do not write; report what is out of date
 *   remap    CSV file names (or pairs) whose versions move to the current model versions
 * Returns { results: [{ csv, generated, status, errors, warnings }], errors, warnings }.
 */
export async function runMaps({ dir, canonical, models = [], elementsOf = null, check = false, remap = [], only = null, now, log = console.error }) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.csv'));
  } catch (err) {
    if (err.code === 'ENOENT') files = [];
    else throw err;
  }
  if (only) files = files.filter((f) => only.includes(f) || only.includes(f.replace(/\.csv$/i, '')));
  const genDir = path.join(dir, GENERATED_DIR);
  const results = [];
  const find = (side, ref) => models.find((m) => m.side === side && m.preferred !== false && [m.name, m.id, m.url].includes(ref));

  for (const f of files.sort()) {
    const res = { csv: f, generated: `${GENERATED_DIR}/${generatedName(f)}`, status: 'ok', errors: [], warnings: [] };
    results.push(res);
    const pair = pairOf(f);
    if (!pair) {
      res.errors.push(`${f}: name it <EHDSModel>--<BeModel>.csv`);
      res.status = 'error';
      continue;
    }
    const { rows, errors } = readMappingCsv(await readFile(path.join(dir, f), 'utf8'), f);
    res.errors.push(...errors);

    const genFile = path.join(genDir, generatedName(f));
    let previous = null;
    let previousText = null;
    try {
      previousText = await readFile(genFile, 'utf8');
      previous = JSON.parse(previousText);
    } catch (err) {
      if (err.code !== 'ENOENT') res.errors.push(`${res.generated}: ${err.message}`);
    }
    const sourceEntry = find('ehds', pair.source);
    const targetEntry = find('be', pair.target);
    if (!previous && !sourceEntry) res.errors.push(`${f}: EHDS model ${pair.source} not found (fetch the models first)`);
    if (!previous && !targetEntry) res.errors.push(`${f}: Belgian model ${pair.target} not found (fetch the models first)`);

    // element codes against the models, when they are loaded
    if (elementsOf) {
      const src = sourceEntry ? await elementsOf(sourceEntry) : null;
      const tgt = targetEntry ? await elementsOf(targetEntry) : null;
      if (src) {
        const unknown = [...new Set(rows.map((r) => r.sourceCode).filter((c) => c && !src.has(c)))];
        if (unknown.length) res.warnings.push(`${f}: not in ${pair.source}: ${unknown.join(', ')}`);
        const listed = new Set(rows.map((r) => r.sourceCode));
        const missing = [...src].filter((c) => c.includes('.') && !listed.has(c) && !/\.(id|extension|modifierExtension)$/.test(c));
        if (missing.length) res.warnings.push(`${f}: ${missing.length} element${missing.length > 1 ? 's' : ''} of ${pair.source} not in the CSV (counted as open): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}`);
      }
      if (tgt) {
        const unknown = [...new Set(rows.map((r) => r.targetCode).filter((c) => c && !tgt.has(c)))];
        if (unknown.length) res.warnings.push(`${f}: not in ${pair.target}: ${unknown.join(', ')}`);
      }
    }
    if (res.errors.length) {
      res.status = 'error';
      continue;
    }

    const doRemap = remap.some((r) => r === f || r === f.replace(/\.csv$/i, '') || r === pair.source);
    const info = (e, fallback) => (e ? { url: e.url, version: e.version ?? null, name: e.name, title: e.title } : { name: fallback });
    const cm = conceptMapFromCsv({ file: f, rows, source: info(sourceEntry, pair.source), target: info(targetEntry, pair.target), canonical, previous, remap: doRemap, now });
    const text = JSON.stringify(cm, null, 2) + '\n';
    // git may check the file out with CRLF (core.autocrlf): compare without line-ending differences
    if (previousText && text === previousText.replace(/\r\n/g, '\n')) continue;
    res.status = previous ? (doRemap ? 'remapped' : 'updated') : 'new';
    if (check) {
      res.errors.push(`${res.generated} is ${previous ? 'out of date with' : 'missing for'} ${f} - run "ehds-tools maps"`);
      res.status = 'error';
      continue;
    }
    await mkdir(genDir, { recursive: true });
    await writeFile(genFile, text);
  }

  // generated ConceptMaps whose CSV is gone
  let generated = [];
  try {
    generated = (await readdir(genDir)).filter((g) => g.endsWith('.json'));
  } catch {}
  const orphans = only ? [] : generated.filter((g) => !results.some((r) => r.generated === `${GENERATED_DIR}/${g}`));
  for (const o of orphans) results.push({ csv: null, generated: `${GENERATED_DIR}/${o}`, status: 'error', errors: [`${GENERATED_DIR}/${o} has no CSV - delete it or restore the CSV`], warnings: [] });

  const errors = results.flatMap((r) => r.errors);
  const warnings = results.flatMap((r) => r.warnings);
  for (const r of results) if (r.csv && r.status !== 'ok') log(`${r.csv}: ${r.status}`);
  return { results, errors, warnings };
}
