import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

/** Download a URL into a Buffer; throws with the HTTP status on failure. */
export async function download(url, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'ehds-tools' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Extract a .tgz buffer into a new temporary directory; returns its path. The caller removes it. */
export async function extractTgz(buffer, { strip = 0 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ehds-tools-'));
  const file = path.join(dir, '.download.tgz');
  await writeFile(file, buffer);
  const out = path.join(dir, 'x');
  await mkdir(out);
  await tar.x({ file, cwd: out, strip });
  await rm(file);
  return { dir, root: out };
}

/** Read every *.json resource in a directory (non-recursive). */
export async function readResources(dir) {
  const resources = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.json') || name === 'package.json' || name.startsWith('.')) continue;
    try {
      const res = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (res && typeof res === 'object' && res.resourceType) resources.push(res);
    } catch {
      // not a FHIR resource (e.g. .index.json, other metadata) - ignore
    }
  }
  return resources;
}

/** Read a FHIR NPM package (package.tgz). Returns its package.json manifest and resources. */
export async function readFhirPackage(buffer) {
  const { dir, root } = await extractTgz(buffer);
  try {
    const pkgDir = path.join(root, 'package');
    const manifest = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
    return { manifest, resources: await readResources(pkgDir) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function isLogicalModel(res) {
  return res.resourceType === 'StructureDefinition' && res.kind === 'logical';
}
