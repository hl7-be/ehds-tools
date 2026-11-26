import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchBelgianSource } from './belgian-source.js';
import { classify, entryFor, resolveVariants } from './catalog.js';
import { fetchEhds } from './ehds-source.js';

/**
 * Fetch both sides and write <output>:
 *   catalog.json                     every model and profile, both sides, with provenance
 *   ehds/models/<key>.json           the EHDS StructureDefinitions
 *   be/models/<key>.json             the Belgian StructureDefinitions
 * `only` = 'ehds' | 'be' refreshes one side and keeps the other from the previous catalog.
 */
export async function fetchAll(config, { only = null, log = console.error, fetchImpl = fetch, runSushi } = {}) {
  const previous = only ? await readCatalog(config.output).catch(() => null) : null;
  const catalog = {
    generatedAt: new Date().toISOString(),
    sides: { ehds: previous?.sides?.ehds ?? null, be: previous?.sides?.be ?? [] },
    models: previous ? previous.models.filter((m) => m.side !== only) : [],
  };

  if (!only || only === 'ehds') {
    await clearSide(config.output, 'ehds');
    const got = await fetchEhds(config.ehds, { log, fetchImpl, runSushi });
    const entries = await keep(config.output, 'ehds', got, config.ehds.kinds);
    if (!entries.some((e) => e.kind === 'logical')) throw new Error(`No logical models found in ${config.ehds.url}`);
    catalog.sides.ehds = { ...got.provenance, fetchedAt: catalog.generatedAt, count: entries.length };
    catalog.models.push(...entries);
  }

  if (!only || only === 'be') {
    await clearSide(config.output, 'be');
    catalog.sides.be = [];
    for (const entry of config.belgian.sources) {
      try {
        const got = await fetchBelgianSource(entry, { fetchImpl, log });
        const entries = await keep(config.output, 'be', got, config.belgian.kinds);
        catalog.sides.be.push({ ...got.provenance, fetchedAt: catalog.generatedAt, count: entries.length });
        catalog.models.push(...entries);
      } catch (err) {
        // one unreachable package should not stop the rest
        log(`  failed: ${err.message}`);
        catalog.sides.be.push({ description: entry.kind, error: err.message, fetchedAt: catalog.generatedAt, count: 0 });
      }
    }
  }

  resolveVariants(catalog.models);
  await writeJson(path.join(config.output, 'catalog.json'), catalog);
  const count = (side, kind) => catalog.models.filter((m) => m.side === side && m.kind === kind && m.preferred).length;
  log(`EHDS: ${count('ehds', 'logical')} logical models, ${count('ehds', 'profile')} profiles; ` +
    `BE: ${count('be', 'logical')} logical models, ${count('be', 'profile')} profiles`);
  return catalog;
}

/** Write the kept StructureDefinitions of one source and return their catalog entries. */
async function keep(output, side, { resources, pkg, source }, kinds) {
  const entries = [];
  for (const sd of resources) {
    const kind = classify(sd);
    if (!kind || !kinds.includes(kind)) continue;
    const entry = entryFor(sd, { side, pkg, source, kind });
    entries.push(entry);
  }
  for (const entry of entries) {
    const sd = resources.find((r) => r.id === entry.id && r.url === entry.url);
    await writeJson(path.join(output, entry.files.sd), sd);
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function clearSide(output, side) {
  await rm(path.join(output, side), { recursive: true, force: true });
}

export async function readCatalog(output) {
  try {
    return JSON.parse(await readFile(path.join(output, 'catalog.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No catalog in ${output} - run "ehds-tools fetch" first`);
    throw err;
  }
}

export async function readModel(output, entry) {
  return JSON.parse(await readFile(path.join(output, entry.files.sd), 'utf8'));
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}
