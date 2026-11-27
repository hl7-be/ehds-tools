import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { conceptMapFromCsv, pairOf, parseCsv, readMappingCsv, runMaps, scaffoldCsv, toCsv } from '../src/csv-mappings.js';
import { loadMappings, mappingGroups } from '../src/mappings.js';

const HEADER = 'sourceCode,sourceDisplay,relationship,targetCode,targetDisplay,comment';
const SRC = { side: 'ehds', name: 'EHDSCondition', id: 'EHDSCondition', url: 'http://ehds.eu/SD/EHDSCondition', version: '0.3.0' };
const TGT = { side: 'be', name: 'BeModelProblem', id: 'BeModelProblem', url: 'https://be/SD/BeModelProblem', version: '1.4.0' };

test('CSV: quotes, doubled quotes, commas and line breaks in quotes, CRLF, BOM; round trip', () => {
  const text = '﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\n';
  assert.deepEqual(parseCsv(text), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'two\nlines']]);
  assert.deepEqual(parseCsv(toCsv(parseCsv(text))), parseCsv(text));
});

test('mapping CSV: format problems are reported with their line', () => {
  const { errors } = readMappingCsv(
    [HEADER, 'A.x,,equivalent,,,', 'A.y,,unmatched,B.y,,', 'A.z,,maybe,B.z,,', 'A.w,,,B.w,,', 'A.v,,equivalent,B.v,,', 'A.v,,unmatched,,,'].join('\n'),
    'm.csv',
  );
  assert.equal(errors.length, 5);
  assert.match(errors[0], /m\.csv:2: equivalent without a targetCode/);
  assert.match(errors[1], /m\.csv:3: unmatched with a targetCode/);
  assert.match(errors[2], /m\.csv:4: relationship "maybe"/);
  assert.match(errors[3], /m\.csv:5: targetCode without a relationship/);
  assert.match(errors[4], /A\.v is on lines 6, 7 with different kinds/);
  assert.match(readMappingCsv('a,b\n1,2', 'x.csv').errors[0], /missing columns/);
});

test('pair from the file name: the Belgian name may contain dashes', () => {
  assert.deepEqual(pairOf('EHDSAllergyIntolerance--be-model-allergyintolerance.csv'), { source: 'EHDSAllergyIntolerance', target: 'be-model-allergyintolerance' });
  assert.equal(pairOf('no-pair.csv'), null);
});

test('ConceptMap from CSV: mapped, several targets, unmatched, open with a comment', () => {
  const { rows } = readMappingCsv(
    [HEADER, 'EHDSCondition.code,Code,equivalent,BeModelProblem.code,,', 'EHDSCondition.onset,Onset,narrower,BeModelProblem.onset[x],,"date only, no age"',
      'EHDSCondition.onset,Onset,narrower,BeModelProblem.onsetAge,,', 'EHDSCondition.version,,unmatched,,,No version', 'EHDSCondition.note,,,,,*TODO* ask'].join('\r\n'),
  );
  const cm = conceptMapFromCsv({ file: 'EHDSCondition--BeModelProblem.csv', rows, source: SRC, target: TGT, canonical: 'http://x/ConceptMap', now: '2026-01-01T00:00:00Z' });
  assert.equal(cm.sourceCanonical, `${SRC.url}|0.3.0`);
  assert.equal(cm.group[0].targetVersion, '1.4.0');
  const [g] = mappingGroups([{ file: 'generated/ConceptMap-EHDSCondition--BeModelProblem.json', resource: cm }]);
  assert.equal(g.csv, 'EHDSCondition--BeModelProblem.csv');
  assert.equal(g.sourceVersion, '0.3.0');
  assert.deepEqual(g.elements.map((l) => [l.code, l.status, l.targets.length]), [
    ['EHDSCondition.code', 'mapped', 1],
    ['EHDSCondition.onset', 'mapped', 2],
    ['EHDSCondition.version', 'no-map', 1],
    ['EHDSCondition.note', 'open', 0],
  ]);
  assert.equal(g.elements[1].targets[0].comment, 'date only, no age');
  assert.equal(g.elements[3].openComment, '*TODO* ask');
});

test('versions are kept until remap; the date moves only when the content changes', () => {
  const rows = readMappingCsv(`${HEADER}\nEHDSCondition.code,,equivalent,BeModelProblem.code,,`).rows;
  const args = { file: 'EHDSCondition--BeModelProblem.csv', rows, canonical: 'http://x/ConceptMap' };
  const first = conceptMapFromCsv({ ...args, source: SRC, target: TGT, now: 'T1' });
  const newer = { source: { ...SRC, version: '0.4.0' }, target: { ...TGT, version: '2.0.0' } };
  const same = conceptMapFromCsv({ ...args, ...newer, previous: first, now: 'T2' });
  assert.equal(same.date, 'T1', 'nothing changed');
  assert.equal(same.sourceCanonical, `${SRC.url}|0.3.0`, 'still made against 0.3.0');
  const remapped = conceptMapFromCsv({ ...args, ...newer, previous: first, remap: true, now: 'T3' });
  assert.equal(remapped.sourceCanonical, `${SRC.url}|0.4.0`);
  assert.equal(remapped.group[0].targetVersion, '2.0.0');
  assert.equal(remapped.date, 'T3');
  const noModels = conceptMapFromCsv({ ...args, source: { name: 'EHDSCondition' }, target: { name: 'BeModelProblem' }, previous: first, now: 'T4' });
  assert.deepEqual(noModels, first, 'without the models fetched, the result is the same (maps --check in CI)');
});

test('runMaps: generate, check, out of date, orphan, scaffold', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ehds-csv-'));
  try {
    const sd = { snapshot: { element: [{ id: 'EHDSCondition', path: 'EHDSCondition' }, { id: 'EHDSCondition.code', path: 'EHDSCondition.code', short: 'Code' }] } };
    const csv = path.join(dir, 'EHDSCondition--BeModelProblem.csv');
    await writeFile(csv, scaffoldCsv(sd));
    assert.match(await readFile(csv, 'utf8'), /^sourceCode,.*\r\nEHDSCondition\.code,Code,,,,\r\n$/);
    const opts = { dir, canonical: 'http://x/ConceptMap', models: [SRC, TGT], log: () => {} };

    let r = await runMaps(opts);
    assert.equal(r.results[0].status, 'new');
    assert.deepEqual(r.errors, []);
    assert.equal((await runMaps({ ...opts, check: true })).errors.length, 0);

    await writeFile(csv, `${HEADER}\r\nEHDSCondition.code,Code,equivalent,BeModelProblem.code,,\r\n`);
    r = await runMaps({ ...opts, check: true, models: [] });
    assert.match(r.errors[0], /out of date/);
    r = await runMaps(opts);
    assert.equal(r.results[0].status, 'updated');
    const [m] = await loadMappings(dir);
    assert.equal(m.file, 'generated/ConceptMap-EHDSCondition--BeModelProblem.json');

    await writeFile(path.join(dir, 'generated', 'ConceptMap-Gone--BeX.json'), '{}');
    r = await runMaps({ ...opts, check: true });
    assert.match(r.errors[0], /ConceptMap-Gone--BeX\.json has no CSV/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
