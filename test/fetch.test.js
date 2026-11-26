import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as tar from 'tar';
import { parseBuildUrl } from '../src/belgian-source.js';
import { classify, packageDate, resolveVariants } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { staleness } from '../src/ehds-source.js';
import { fetchAll } from '../src/fetch.js';
import { parseGitHubUrl, publishedPackageUrls } from '../src/github.js';

test('parseGitHubUrl accepts repo URLs with trailing slash, .git and /tree/<ref>', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/EEHRxF/logical-model/'), { owner: 'EEHRxF', repo: 'logical-model', ref: null });
  assert.deepEqual(parseGitHubUrl('https://github.com/EEHRxF/logical-model.git'), { owner: 'EEHRxF', repo: 'logical-model', ref: null });
  assert.deepEqual(parseGitHubUrl('https://github.com/EEHRxF/logical-model/tree/non-paper-v5'), { owner: 'EEHRxF', repo: 'logical-model', ref: 'non-paper-v5' });
  assert.throws(() => parseGitHubUrl('https://gitlab.com/a/b'), /github.com/);
});

test('publishedPackageUrls: default branch uses CI root then GitHub Pages; other branches use CI branch build', () => {
  const gh = { owner: 'EEHRxF', repo: 'logical-model' };
  assert.deepEqual(publishedPackageUrls({ ...gh, ref: 'main', defaultBranch: 'main' }), [
    'https://build.fhir.org/ig/EEHRxF/logical-model/package.tgz',
    'https://eehrxf.github.io/logical-model/package.tgz',
  ]);
  assert.deepEqual(publishedPackageUrls({ ...gh, ref: 'non-paper-v5', defaultBranch: 'main' }), [
    'https://build.fhir.org/ig/EEHRxF/logical-model/branches/non-paper-v5/package.tgz',
  ]);
});

test('parseBuildUrl ignores the language folder', () => {
  assert.deepEqual(parseBuildUrl('https://build.fhir.org/ig/hl7-be/patient-dossier/branches/clinical-report/en/'), { owner: 'hl7-be', repo: 'patient-dossier', branch: 'clinical-report' });
  assert.deepEqual(parseBuildUrl('https://build.fhir.org/ig/hl7-be/core/'), { owner: 'hl7-be', repo: 'core', branch: '' });
});

test('config precedence: overrides > env > file > defaults; empty values ignored', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ehds-cfg-'));
  const file = path.join(dir, 'c.json');
  await writeFile(file, JSON.stringify({ ehds: { url: 'https://github.com/a/file', ref: 'f' }, output: 'out-file' }));
  const c = await loadConfig({ configFile: file, env: { EHDS_SOURCE_REF: 'e', EHDS_SOURCE_MODE: '' }, overrides: { ehds: { mode: 'published' } } });
  assert.equal(c.ehds.url, 'https://github.com/a/file');
  assert.equal(c.ehds.ref, 'e');
  assert.equal(c.ehds.mode, 'published');
  assert.equal(c.output, path.resolve('out-file'));
  await assert.rejects(loadConfig({ configFile: file, env: {}, overrides: { ehds: { mode: 'x' } } }), /ehds.mode/);
  await rm(dir, { recursive: true });
});

test('classify keeps logical models and profiles, not extensions', () => {
  assert.equal(classify({ resourceType: 'StructureDefinition', kind: 'logical' }), 'logical');
  assert.equal(classify({ resourceType: 'StructureDefinition', kind: 'resource', derivation: 'constraint', type: 'Patient' }), 'profile');
  assert.equal(classify({ resourceType: 'StructureDefinition', kind: 'complex-type', derivation: 'constraint', type: 'Extension' }), null);
  assert.equal(classify({ resourceType: 'ValueSet' }), null);
});

test('package dates and staleness', () => {
  assert.equal(packageDate('20261121161414'), '2026-11-21T16:14:14Z');
  assert.match(staleness('20261121161414', '2026-11-22T10:00:00Z'), /older than the latest commit/);
  assert.equal(staleness('20261121161414', '2026-11-20T10:00:00Z'), null);
});

test('resolveVariants: the first source of the same url prevails', () => {
  const es = resolveVariants([{ key: 'a', url: 'u' }, { key: 'b', url: 'u' }, { key: 'c', url: 'v' }]);
  assert.deepEqual(es.map((e) => [e.key, e.preferred, e.variants?.length ?? 0]), [['a', true, 2], ['b', false, 2], ['c', true, 0]]);
});

async function makePackage(name, resources) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ehds-pkg-'));
  await mkdir(path.join(dir, 'package'));
  await writeFile(path.join(dir, 'package', 'package.json'), JSON.stringify({ name, version: '1.0.0', date: '20261121161414', url: `https://example.org/${name}` }));
  for (const r of resources) await writeFile(path.join(dir, 'package', `${r.resourceType}-${r.id}.json`), JSON.stringify(r));
  const file = path.join(dir, 'package.tgz');
  await tar.c({ gzip: true, file, cwd: dir }, ['package']);
  const buf = await readFile(file);
  await rm(dir, { recursive: true });
  return buf;
}

const sd = (id, extra = {}) => ({ resourceType: 'StructureDefinition', id, name: id, url: `http://x/${id}`, kind: 'logical', type: id, snapshot: { element: [{ path: id }, { path: `${id}.name` }] }, ...extra });

test('fetchAll: both sides, catalog with kinds, stages and files', async () => {
  const ehdsPkg = await makePackage('eu.ehds.models', [sd('EHDSPatient'), { resourceType: 'ValueSet', id: 'vs' }]);
  const bePkg = await makePackage('hl7.fhir.be.core-clinical', [sd('BeModelPatient'), sd('BePatient', { kind: 'resource', derivation: 'constraint', type: 'Patient' })]);
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.github.com/')) return new Response('', { status: 403 });
    if (url === 'https://build.fhir.org/ig/o/r/package.tgz') return new Response(ehdsPkg);
    if (url === 'https://packages.fhir.org/hl7.fhir.be.core-clinical') return Response.json({ 'dist-tags': { latest: '1.0.0' } });
    if (url === 'https://packages.fhir.org/hl7.fhir.be.core-clinical/1.0.0') return new Response(bePkg);
    return new Response('', { status: 404 });
  };
  const out = await mkdtemp(path.join(os.tmpdir(), 'ehds-out-'));
  const config = {
    ehds: { url: 'https://github.com/o/r', ref: 'main', mode: 'auto', packageUrl: null, kinds: ['logical', 'profile'] },
    belgian: { kinds: ['logical', 'profile'], sources: [{ kind: 'release', packageId: 'hl7.fhir.be.core-clinical', version: 'latest' }, { kind: 'release', packageId: 'missing' }] },
    output: out,
  };
  const catalog = await fetchAll(config, { fetchImpl, log: () => {} });

  assert.equal(catalog.sides.ehds.mode, 'published');
  assert.deepEqual(catalog.models.map((m) => [m.side, m.id, m.kind, m.stage]), [
    ['ehds', 'EHDSPatient', 'logical', 'draft'],
    ['be', 'BeModelPatient', 'logical', 'published'],
    ['be', 'BePatient', 'profile', 'published'],
  ]);
  assert.equal(catalog.models[1].package.label, 'Core Clinical');
  assert.match(catalog.sides.be[1].error, /registry HTTP 404/); // one bad source does not stop the rest
  const written = JSON.parse(await readFile(path.join(out, catalog.models[0].files.sd), 'utf8'));
  assert.equal(written.id, 'EHDSPatient');
  await rm(out, { recursive: true });
});

test('fetchAll mode=published fails clearly when nothing is published', async () => {
  const fetchImpl = async () => new Response('', { status: 404 });
  const out = await mkdtemp(path.join(os.tmpdir(), 'ehds-out-'));
  const config = { ehds: { url: 'https://github.com/o/r', ref: 'feature', mode: 'published', packageUrl: null, kinds: ['logical'] }, belgian: { kinds: ['logical'], sources: [] }, output: out };
  await assert.rejects(fetchAll(config, { fetchImpl, log: () => {} }), /No published package found/);
  await rm(out, { recursive: true });
});
