import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCompare } from './compare.js';
import { loadCompositions } from './compositions.js';
import { runProgress } from './progress.js';
import { renderAll } from './render.js';
import { toMarkdown } from './report.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Build the static site published on GitHub Pages (and previewed with `serve`):
 *   index.html, app.js, styles.css, ehds.css     the front end (public/)
 *   data/catalog.json                            every model and profile, both sides, with its
 *                                                place (tier, compositions, tags: compositions.json)
 *   data/{ehds,be}/models|diagrams/...           StructureDefinitions, PlantUML, SVG
 *   data/comparison.json|.md                     the mappings compared with the models
 *   data/progress.json                           mapping progress over time (git history)
 */
export async function buildSite(config, { log = console.error } = {}) {
  await renderAll(config, { log });
  const dir = config.site;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(PUBLIC, dir, { recursive: true });
  await cp(config.output, path.join(dir, 'data'), { recursive: true });

  const report = await runCompare(config);
  await placeCatalog(path.join(dir, 'data', 'catalog.json'), report, await loadCompositions(config.compositions));
  await writeFile(path.join(dir, 'data', 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(dir, 'data', 'comparison.md'), toMarkdown(report));
  const progress = await runProgress(config, { log });
  await writeFile(path.join(dir, 'data', 'progress.json'), JSON.stringify(progress, null, 2) + '\n');
  // GitHub Pages: serve files as they are (no Jekyll)
  await writeFile(path.join(dir, '.nojekyll'), '');
  log(`site written to ${dir}`);
  return report;
}

/** Write the compositions into the site's catalog: place on every model, the compositions list. */
async function placeCatalog(file, report, compositions) {
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  const ehds = new Map(report.models.map((m) => [m.key, m.place]));
  for (const m of catalog.models) {
    const place = m.side === 'ehds' ? ehds.get(m.key) : report.placedTargets?.[m.key];
    const tags = [...new Set([...(place?.tags ?? []), ...(compositions.tags[m.name] ?? compositions.tags[m.id] ?? [])])];
    m.place = place ? { ...place, tags, inherited: m.side !== 'ehds' } : { tier: null, compositions: [], tags };
  }
  catalog.compositions = report.compositions.map(({ id, title, description, sections }) => ({ id, title, description, sections }));
  catalog.unknownPlacements = report.unknownPlacements;
  await writeFile(file, JSON.stringify(catalog, null, 2) + '\n');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Serve the site directory on localhost. Resolves with the server once listening. */
export function serveSite(dir, { port = 8080, log = console.error } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      if ((await stat(file)).isDirectory()) {
        res.writeHead(301, { Location: rel + '/' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch (err) {
      res.writeHead(err.code === 'EACCES' ? 403 : 404, { 'Content-Type': 'text/plain' }).end(err.code === 'EACCES' ? 'Forbidden' : 'Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`serving ${root} at http://localhost:${server.address().port}/ (Ctrl+C to stop)`);
      resolve(server);
    });
  });
}

/** Open a URL in the browser (Firefox when available). */
export function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  const child =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', 'firefox', url], opts)
      : process.platform === 'darwin'
        ? spawn('open', ['-a', 'Firefox', url], opts)
        : spawn('firefox', [url], opts);
  child.on('error', () => console.error(`open ${url} in your browser`));
  child.unref();
}
