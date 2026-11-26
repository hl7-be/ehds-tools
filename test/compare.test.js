import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compare } from '../src/compare.js';
import { loadMappings, mappingGroups, scaffoldConceptMap, splitCanonical } from '../src/mappings.js';
import { versionEvents } from '../src/progress.js';
import { toMarkdown } from '../src/report.js';

const patient = {
  resourceType: 'StructureDefinition',
  id: 'EHDSPatient',
  name: 'EHDSPatient',
  title: 'Patient model',
  url: 'http://ehds.eu/fhir/models/StructureDefinition/EHDSPatient',
  version: '0.3.0',
  kind: 'logical',
  snapshot: {
    element: [
      { id: 'EHDSPatient', path: 'EHDSPatient' },
      { id: 'EHDSPatient.name', path: 'EHDSPatient.name', short: 'Name' },
      { id: 'EHDSPatient.dateOfBirth', path: 'EHDSPatient.dateOfBirth' },
      { id: 'EHDSPatient.genderIdentity', path: 'EHDSPatient.genderIdentity' },
      { id: 'EHDSPatient.deceased[x]', path: 'EHDSPatient.deceased[x]' },
    ],
  },
};
const address = { ...patient, id: 'EHDSAddress', name: 'EHDSAddress', url: 'http://ehds.eu/fhir/models/StructureDefinition/EHDSAddress', snapshot: { element: [{ id: 'EHDSAddress', path: 'EHDSAddress' }, { id: 'EHDSAddress.city', path: 'EHDSAddress.city' }] } };
const BE = 'https://www.ehealth.fgov.be/standards/fhir/core/StructureDefinition/BeModelPatient';
const bePatient = { resourceType: 'StructureDefinition', id: 'BeModelPatient', name: 'BeModelPatient', url: BE, kind: 'logical', snapshot: { element: [{ id: 'BeModelPatient', path: 'BeModelPatient' }, { id: 'BeModelPatient.name', path: 'BeModelPatient.name' }, { id: 'BeModelPatient.birthDate', path: 'BeModelPatient.birthDate' }] } };

const entry = (sd, extra = {}) => ({ key: `k-${sd.id}`, id: sd.id, name: sd.name, kind: 'logical', url: sd.url, version: sd.version ?? '1.0.0', date: '2026-11-01T00:00:00Z', ...extra });
const ehds = (sd, extra) => ({ entry: entry(sd, extra), sd });
const targets = (extra) => new Map([[BE, { entry: entry(bePatient, extra), sd: bePatient }]]);

const conceptMap = {
  resourceType: 'ConceptMap',
  id: 'EHDSPatient-to-BeModelPatient',
  title: 'Patient model to BeModelPatient',
  status: 'draft',
  date: '2026-11-10T00:00:00Z',
  sourceScopeCanonical: `${patient.url}|0.3.0`,
  targetScopeCanonical: `${BE}|1.0.0`,
  group: [
    {
      source: patient.url,
      target: BE,
      element: [
        { code: 'EHDSPatient.name', target: [{ code: 'BeModelPatient.name', relationship: 'equivalent' }] },
        { code: 'EHDSPatient.dateOfBirth', target: [{ code: 'BeModelPatient.birthDate', relationship: 'equivalent', comment: 'BE requires a full date' }] },
        { code: 'EHDSPatient.genderIdentity', target: [{ relationship: 'not-related-to', comment: 'Not collected in Belgium' }] },
        { code: 'EHDSPatient.deceased[x]' },
        { code: 'EHDSPatient.nickname', target: [{ code: 'BeModelPatient.alias', relationship: 'equivalent' }] },
      ],
    },
  ],
};

test('mapping lines: mapped, no-map (with remark) and open; versions from the scope canonicals', () => {
  const [g] = mappingGroups([{ file: 'a.json', resource: conceptMap }]);
  assert.deepEqual(g.elements.map((e) => e.status), ['mapped', 'mapped', 'no-map', 'open', 'mapped']);
  assert.equal(g.source, patient.url);
  assert.equal(g.target, BE);
  assert.equal(g.sourceVersion, '0.3.0');
  assert.equal(g.targetVersion, '1.0.0');
  assert.deepEqual(splitCanonical('http://x|2'), { url: 'http://x', version: '2' });
});

test('compare: mapped models first, counts, remarks, unknown elements on both sides', () => {
  const groups = mappingGroups([{ file: 'a.json', resource: conceptMap }]);
  const r = compare([ehds(address), ehds(patient)], groups, targets());
  assert.deepEqual(r.summary, { models: 2, mapped: 1, withRemarks: 1, remarks: 2, conceptMaps: 1, outdated: 0 });
  assert.deepEqual(r.models.map((m) => m.id), ['EHDSPatient', 'EHDSAddress']);
  const [m] = r.models[0].mappings;
  assert.deepEqual(m.counts, { mapped: 2, noMap: 1, open: 1 });
  assert.equal(m.targetKey, 'k-BeModelPatient');
  assert.deepEqual(m.remarks.map((x) => [x.element, x.remark]), [
    ['EHDSPatient.dateOfBirth', 'BE requires a full date'],
    ['EHDSPatient.genderIdentity', 'Not collected in Belgium'],
  ]);
  assert.deepEqual(m.unknownElements, ['EHDSPatient.nickname']);
  assert.deepEqual(m.unknownTargets, ['BeModelPatient.alias']);
  assert.equal(r.models[1].mapped, false);
});

test('compare flags a model that changed since the mapping (version, or date after ConceptMap.date)', () => {
  const groups = mappingGroups([{ file: 'a.json', resource: conceptMap }]);
  const r1 = compare([ehds(patient, { version: '0.4.0' })], groups, targets());
  assert.deepEqual(r1.models[0].mappings[0].changes, [{ side: 'ehds', what: 'version', mapped: '0.3.0', now: '0.4.0' }]);
  const r2 = compare([ehds(patient, { version: '0.3.0' })], groups, targets({ date: '2026-11-20T00:00:00Z' }));
  assert.deepEqual(r2.models[0].mappings[0].changes.map((c) => [c.side, c.what]), [['be', 'date']]);
  assert.equal(r2.summary.outdated, 1);
});

test('compare reports ConceptMaps whose source is not a fetched model, and targets not fetched', () => {
  const cm = { ...conceptMap, group: [{ ...conceptMap.group[0], source: 'http://other/Model' }] };
  const r = compare([ehds(patient)], mappingGroups([{ file: 'b.json', resource: cm }]));
  assert.deepEqual(r.unknownSources, [{ file: 'b.json', source: 'http://other/Model', target: BE }]);
  const r2 = compare([ehds(patient)], mappingGroups([{ file: 'a.json', resource: conceptMap }]));
  assert.equal(r2.models[0].mappings[0].targetFound, false);
});

test('R4 ConceptMaps (equivalence, sourceUri/targetUri) are read', () => {
  const r4 = { resourceType: 'ConceptMap', id: 'r4', sourceUri: patient.url, targetUri: BE, group: [{ element: [{ code: 'EHDSPatient.name', target: [{ code: 'x', equivalence: 'equivalent', comment: 'r' }] }] }] };
  const [g] = mappingGroups([{ file: 'r4.json', resource: r4 }]);
  assert.equal(g.source, patient.url);
  assert.equal(g.elements[0].targets[0].relationship, 'equivalent');
});

test('scaffold lists every element, nothing mapped, versions and date recorded', () => {
  const cm = scaffoldConceptMap({
    source: { sd: patient, entry: entry(patient) },
    target: { entry: entry(bePatient, { version: '1.2.0' }) },
    canonical: 'https://example.org/ConceptMap/',
    date: '2026-11-26T00:00:00Z',
  });
  assert.equal(cm.id, 'EHDSPatient-to-BeModelPatient');
  assert.equal(cm.url, 'https://example.org/ConceptMap/EHDSPatient-to-BeModelPatient');
  assert.equal(cm.sourceScopeCanonical, `${patient.url}|0.3.0`);
  assert.equal(cm.targetScopeCanonical, `${BE}|1.2.0`);
  assert.equal(cm.date, '2026-11-26T00:00:00Z');
  assert.deepEqual(cm.group[0].element.map((e) => e.code), ['EHDSPatient.name', 'EHDSPatient.dateOfBirth', 'EHDSPatient.genderIdentity', 'EHDSPatient.deceased[x]']);
  const r = compare([ehds(patient)], mappingGroups([{ file: 'c.json', resource: cm }]), targets());
  assert.deepEqual(r.models[0].mappings[0].counts, { mapped: 0, noMap: 0, open: 4 });
});

test('loadMappings reads ConceptMaps recursively and skips other resources; missing dir is empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ehds-map-'));
  await writeFile(path.join(dir, 'cm.json'), JSON.stringify(conceptMap));
  await writeFile(path.join(dir, 'other.json'), JSON.stringify({ resourceType: 'ValueSet' }));
  const maps = await loadMappings(dir);
  assert.deepEqual(maps.map((m) => m.file), ['cm.json']);
  assert.deepEqual(await loadMappings(path.join(dir, 'nope')), []);
  await rm(dir, { recursive: true });
});

test('markdown report lists remarks and escapes table pipes', () => {
  const cm = structuredClone(conceptMap);
  cm.group[0].element[1].target[0].comment = 'a | b';
  const r = compare([ehds(patient)], mappingGroups([{ file: 'a.json', resource: cm }]), targets());
  const md = toMarkdown(r);
  assert.match(md, /a \\\| b/);
  assert.match(md, /Not collected in Belgium/);
  assert.match(md, /elements not in BeModelPatient: BeModelPatient.alias/);
});

test('version events: start of a mapping and a change of model version', () => {
  const v = (s, t) => ({ conceptMap: 'cm', model: 'EHDSPatient', target: 'BeModelPatient', sourceVersion: s, targetVersion: t });
  const ev = versionEvents([
    { date: 'd1', commit: 'a', versions: [v('0.3.0', '1.0.0')] },
    { date: 'd2', commit: 'b', versions: [v('0.3.0', '1.0.0')] },
    { date: 'd3', commit: 'c', versions: [v('0.4.0', '1.0.0')] },
  ]);
  assert.deepEqual(ev.map((e) => [e.date, e.text]), [
    ['d1', 'EHDSPatient → BeModelPatient started (EHDS 0.3.0, BE 1.0.0)'],
    ['d3', 'EHDSPatient → BeModelPatient: EHDS model 0.3.0 → 0.4.0'],
  ]);
});
