// Downloads the PlantUML jar used to render the diagrams (as in the CareSets tool).
// Without it (or without Java) rendering falls back to plantuml.com.

import fs from 'node:fs/promises';
import path from 'node:path';
import { JAR } from '../src/diagrams/plantuml.js';

// The MIT-licensed distribution ships the Smetana layout engine, so no Graphviz is needed.
const ASSET = /^plantuml-mit-[\d.]+\.jar$/;

async function main() {
  const force = process.argv.includes('--force');
  try {
    const stat = await fs.stat(JAR);
    if (!force && stat.size > 1_000_000) {
      console.log(`plantuml.jar already present (${(stat.size / 1e6).toFixed(1)} MB). Use --force to replace it.`);
      return;
    }
  } catch {}

  const headers = { 'User-Agent': 'ehds-tools setup', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const resp = await fetch('https://api.github.com/repos/plantuml/plantuml/releases/latest', { headers });
  if (!resp.ok) throw new Error(`GitHub API returned HTTP ${resp.status}`);
  const release = await resp.json();
  const asset = release.assets.find((a) => ASSET.test(a.name));
  if (!asset) throw new Error(`No MIT jar in release ${release.tag_name}`);

  console.log(`Downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)…`);
  const jar = await fetch(asset.browser_download_url);
  if (!jar.ok) throw new Error(`Download returned HTTP ${jar.status}`);
  await fs.mkdir(path.dirname(JAR), { recursive: true });
  await fs.writeFile(JAR, Buffer.from(await jar.arrayBuffer()));
  console.log(`Saved to ${JAR}`);
}

main().catch((err) => {
  console.error(`Could not fetch PlantUML: ${err.message}`);
  console.error('Rendering will fall back to plantuml.com.');
  process.exit(1);
});
