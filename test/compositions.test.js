import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoSections, placeModels, placeTargets } from '../src/compositions.js';

const U = 'http://ehds.eu/fhir/models/StructureDefinition/';
const sd = (name, elements = []) => ({
  resourceType: 'StructureDefinition',
  name,
  url: U + name,
  kind: 'logical',
  type: U + name,
  snapshot: { element: [{ id: name, path: name }, ...elements.map((e) => ({ id: `${name}.${e.path}`, ...e, path: `${name}.${e.path}` }))] },
});
const typed = (path, model, short) => ({ path, short, type: [{ code: U + model }] });
const models = [
  sd('EHDSSummary', [
    { path: 'header', short: 'Header.', type: [{ code: 'Base' }] },
    typed('header.subject', 'EHDSPatient'),
    { path: 'problems', short: 'Section: Medical problems.', type: [{ code: 'Base' }] },
    typed('problems.current', 'EHDSCondition'),
    { path: 'results', short: 'Section: Results. With more text.', type: [{ code: 'Base' }] },
    typed('results.result', 'EHDSObservation'),
    { path: 'functional', short: 'Section: Functional status.', type: [{ code: 'Base' }] },
    typed('functional.condition', 'EHDSCondition'),
    { path: 'story', short: 'Section: Patient story.', type: [{ code: 'Base' }] },
  ]),
  sd('EHDSPrescription', [typed('medication', 'EHDSMedication')]),
  sd('EHDSPatient', [typed('name', 'EHDSHumanName')]),
  sd('EHDSCondition'),
  sd('EHDSObservation'),
  sd('EHDSMedication'),
  sd('EHDSHumanName'),
].map((s) => ({ entry: { key: `ehds--${s.name}`, id: s.name, name: s.name, url: s.url, kind: 'logical' }, sd: s }));
const byUrl = new Map(models.map((m) => [m.entry.url, m.entry.name]));

test('auto sections: the "Section:" elements of the focus model and the models in them', () => {
  const sections = autoSections(models[0].sd, byUrl);
  assert.deepEqual(sections.map((s) => [s.title, s.models]), [
    ['Medical problems', ['EHDSCondition']],
    ['Results', ['EHDSObservation']],
    ['Functional status', ['EHDSCondition']],
    ['Patient story', []],
  ]);
});

test('tiers: focus > section > component > supporting; a model in two sections is listed once', () => {
  const config = {
    compositions: [
      { id: 'ps', title: 'Summary', focus: ['EHDSSummary'], sections: 'auto' },
      { id: 'rx', title: 'Prescription', focus: ['EHDSPrescription'], sections: [{ title: 'Product', models: ['EHDSMedication'] }, 'EHDSMissing'] },
    ],
    components: ['EHDSHumanName', 'EHDSCondition'],
    tags: { EHDSPatient: ['actor'], BeModelPatient: ['be-only'] },
  };
  const { places, compositions, unknown } = placeModels(models, config);
  const tier = (n) => places.get(n).tier;
  assert.equal(tier('EHDSSummary'), 'focus');
  assert.equal(tier('EHDSCondition'), 'section', 'a section, even when also listed as a component');
  assert.equal(tier('EHDSMedication'), 'section');
  assert.equal(tier('EHDSHumanName'), 'component');
  assert.equal(tier('EHDSPatient'), 'supporting');
  assert.deepEqual(places.get('EHDSPatient').tags, ['actor']);
  const ps = compositions.find((c) => c.id === 'ps');
  assert.deepEqual(ps.members.map((m) => [m.role, m.name, m.section]), [
    ['focus', 'EHDSSummary', null],
    ['section', 'EHDSCondition', 'Medical problems, Functional status'],
    ['section', 'EHDSObservation', 'Results'],
  ]);
  assert.deepEqual(unknown, ['EHDSMissing'], 'a configured model that does not exist is reported; tags of Belgian models are not');
});

test('a Belgian model takes the best place of the EHDS models mapped to it', () => {
  const report = {
    models: [
      { id: 'EHDSCondition', place: { tier: 'section', compositions: [{ id: 'ps', role: 'section', section: 'Problems', order: 1 }] }, mappings: [{ targetKey: 'be--x--BeModelProblem' }] },
      { id: 'EHDSPatient', place: { tier: 'supporting', compositions: [] }, mappings: [{ targetKey: 'be--x--BeModelProblem' }, { targetKey: null }] },
      { id: 'EHDSHumanName', place: { tier: 'component', compositions: [] }, mappings: [] },
    ],
  };
  const out = placeTargets(report);
  assert.deepEqual([...out.keys()], ['be--x--BeModelProblem']);
  const p = out.get('be--x--BeModelProblem');
  assert.equal(p.tier, 'section');
  assert.deepEqual(p.from, ['EHDSCondition', 'EHDSPatient']);
  assert.equal(p.compositions.length, 1);
});
