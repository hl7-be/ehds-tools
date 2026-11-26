import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCatalog, readModel } from './fetch.js';
import { fhirToPlantUML, stageColor } from './diagrams/modelgram.js';
import { renderSvgBatch } from './diagrams/plantuml.js';
import { fhirToUml } from './diagrams/uml.js';

export const DIAGRAMS = {
  modelgram: (sd, bg) => fhirToPlantUML(sd, { bg }),
  uml: (sd, bg) => fhirToUml(sd, { bg }),
};

/**
 * Write the PlantUML of both diagrams for every catalog entry and render them to SVG.
 * SVGs are cached in .cache/diagrams by the hash of their PlantUML, so only changed models render.
 */
export async function renderAll(config, { log = console.error, cacheDir = path.resolve('.cache', 'diagrams'), remote = true } = {}) {
  const catalog = await readCatalog(config.output);
  await mkdir(cacheDir, { recursive: true });

  const todo = [];
  const jobs = [];
  for (const entry of catalog.models) {
    const sd = await readModel(config.output, entry);
    entry.diagrams = {};
    for (const [kind, make] of Object.entries(DIAGRAMS)) {
      const files = { puml: `${entry.side}/diagrams/${entry.key}.${kind}.puml`, svg: `${entry.side}/diagrams/${entry.key}.${kind}.svg` };
      let puml;
      try {
        puml = make(sd, stageColor(entry.stage));
      } catch (err) {
        entry.diagrams[kind] = { error: err.message };
        continue;
      }
      await write(path.join(config.output, files.puml), puml);
      const hash = createHash('sha1').update(puml).digest('hex');
      const cached = path.join(cacheDir, `${hash}.svg`);
      entry.diagrams[kind] = files;
      jobs.push({ entry, kind, files, cached });
      try {
        await readFile(cached);
      } catch {
        todo.push({ key: cached, puml });
      }
    }
  }

  if (todo.length) {
    log(`rendering ${todo.length} diagrams with PlantUML (${jobs.length - todo.length} unchanged)`);
    const results = await renderSvgBatch(todo, { remote });
    for (const [cached, r] of results) if (r.svg) await writeFile(cached, r.svg);
    for (const [cached, r] of results) if (r.error) log(`  ${path.basename(cached)}: ${r.error.split('\n')[0]}`);
  } else {
    log(`${jobs.length} diagrams unchanged`);
  }

  let failed = 0;
  for (const { entry, kind, files, cached } of jobs) {
    try {
      await write(path.join(config.output, files.svg), await readFile(cached, 'utf8'));
    } catch {
      entry.diagrams[kind] = { ...files, svg: null, error: 'not rendered' };
      failed++;
    }
  }
  await write(path.join(config.output, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  if (failed) log(`warning: ${failed} diagrams could not be rendered`);
  return catalog;
}

async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
