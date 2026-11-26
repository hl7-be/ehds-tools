// ---------------------------------------------------------------------------
// PlantUML -> SVG, as in the CareSets tool (server/lib/plantuml.js): the local
// jar (vendor/plantuml.jar, downloaded by `npm run setup`) driven by Java, in
// one batched JVM run. Without Java or the jar it falls back to plantuml.com;
// the models are public specifications, but pass `remote: false` to forbid it.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflate } from 'pako';

export const JAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'plantuml.jar');
const SERVER = 'https://www.plantuml.com/plantuml';
const JAVA_ARGS = ['-Djava.awt.headless=true', '-DPLANTUML_LIMIT_SIZE=16384', '-jar'];

let localAvailable = null;

export async function probeLocal() {
  if (localAvailable !== null) return localAvailable;
  try {
    await fs.access(JAR);
    await run('java', [...JAVA_ARGS, JAR, '-version'], { timeout: 30_000 });
    localAvailable = true;
  } catch {
    localAvailable = false;
  }
  return localAvailable;
}

/** Render many diagrams. entries: [{ key, puml }] -> Map key -> { svg } | { error }. */
export async function renderSvgBatch(entries, { remote = true } = {}) {
  const results = new Map();
  if (!entries.length) return results;

  if (!(await probeLocal())) {
    if (!remote) throw new Error(`PlantUML jar not usable (${JAR}); run "npm run setup" and check Java`);
    for (const { key, puml } of entries) {
      try {
        results.set(key, { svg: await renderRemote(puml) });
      } catch (err) {
        results.set(key, { error: err.message });
      }
    }
    return results;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ehds-puml-'));
  try {
    const names = entries.map((_, i) => `d${String(i).padStart(4, '0')}`);
    await Promise.all(entries.map((e, i) => fs.writeFile(path.join(tmp, `${names[i]}.puml`), e.puml, 'utf8')));
    let batchError = null;
    try {
      await run('java', [...JAVA_ARGS, JAR, '-tsvg', '-charset', 'UTF-8', '-nometadata', `${tmp}${path.sep}*.puml`], { timeout: 900_000 });
    } catch (err) {
      batchError = err.message; // partial output is still worth collecting
    }
    for (const [i, e] of entries.entries()) {
      try {
        results.set(e.key, { svg: await fs.readFile(path.join(tmp, `${names[i]}.svg`), 'utf8') });
      } catch {
        results.set(e.key, { error: batchError ?? 'PlantUML produced no output for this diagram.' });
      }
    }
    return results;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function renderRemote(puml) {
  const r = await fetch(`${SERVER}/svg/~1${encode(puml)}`);
  if (!r.ok) throw new Error(`PlantUML server returned HTTP ${r.status}`);
  return (await r.text()).trim();
}

/** Link to the diagram on plantuml.com (editable there). */
export function plantumlUrl(puml) {
  return `${SERVER}/uml/~1${encode(puml)}`;
}

function run(cmd, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).trim().slice(0, 800) || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

// PlantUML text encoding: deflate + PlantUML's base64 alphabet
function encode(puml) {
  const data = deflate(new TextEncoder().encode(puml), { level: 9 });
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i], b2 = data[i + 1] ?? 0, b3 = data[i + 2] ?? 0;
    out += c6(b1 >> 2) + c6(((b1 & 0x3) << 4) | (b2 >> 4)) + c6(((b2 & 0xf) << 2) | (b3 >> 6)) + c6(b3 & 0x3f);
  }
  return out;
}

function c6(b) {
  if (b < 10) return String.fromCharCode(48 + b);
  b -= 10;
  if (b < 26) return String.fromCharCode(65 + b);
  b -= 26;
  if (b < 26) return String.fromCharCode(97 + b);
  return b === 26 ? '-' : '_';
}
