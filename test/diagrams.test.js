import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fhirToPlantUML } from '../src/diagrams/modelgram.js';
import { fhirToUml } from '../src/diagrams/uml.js';

const sd = {
  resourceType: 'StructureDefinition',
  name: 'EHDSPatient',
  title: 'Patient model',
  differential: {
    element: [
      { id: 'EHDSPatient', path: 'EHDSPatient' },
      { id: 'EHDSPatient.identifier', path: 'EHDSPatient.identifier', min: 1, max: '*', type: [{ code: 'Base' }] },
      { id: 'EHDSPatient.identifier.value', path: 'EHDSPatient.identifier.value', min: 1, max: '1', type: [{ code: 'string' }] },
      { id: 'EHDSPatient.name', path: 'EHDSPatient.name', min: 1, max: '*', type: [{ code: 'http://ehds.eu/fhir/models/StructureDefinition/EHDSHumanName' }] },
      { id: 'EHDSPatient.gp', path: 'EHDSPatient.gp', min: 0, max: '1', type: [{ code: 'Reference', targetProfile: ['http://x/EHDSHealthProfessional'] }] },
      { id: 'EHDSPatient.dateOfBirth', path: 'EHDSPatient.dateOfBirth', min: 0, max: '1', type: [{ code: 'dateTime' }] },
    ],
  },
};

test('modelgram: one class, indented tree with cardinalities', () => {
  const puml = fhirToPlantUML(sd);
  assert.match(puml, /class "\*\*EHDSPatient\*\*" as EHDSPatient \{/);
  assert.match(puml, /\n {2}\|_ identifier 1\.\.\*/);
  assert.match(puml, /\n {4}\|_ value 1\.\.1/);
});

test('uml: backbone elements become classes by composition; other models and references are associations, not attributes', () => {
  const puml = fhirToUml(sd);
  assert.match(puml, /class "Identifier" as c_EHDSPatient_identifier \{\n {2}value : string \[1\.\.1\]\n\}/);
  assert.match(puml, /c_EHDSPatient "1" \*-- "1\.\.\*" c_EHDSPatient_identifier : identifier/);
  assert.match(puml, /c_EHDSPatient --> "1\.\.\*" x_EHDSHumanName : name/);
  assert.match(puml, /c_EHDSPatient --> "0\.\.1" x_EHDSHealthProfessional : gp/);
  assert.match(puml, /dateOfBirth : dateTime \[0\.\.1\]/);
  assert.doesNotMatch(puml, /name : EHDSHumanName/);
});
