import { execFile } from 'node:child_process';
import path from 'node:path';
import { runCompare } from './compare.js';
import { parseConceptMap } from './mappings.js';

/**
 * Mapping progress over time, from the git history of the mappings directory: every commit
 * that touched it is one point (date = commit date), plus the working tree when it has
 * uncommitted changes. Each point is compared with the current models, so the denominator
 * is today's EHDS models; the versions each ConceptMap was made against are recorded per
 * point, and a change of those versions is listed as an event.
 */
export async function runProgress(config, { log = console.error } = {}) {
  const dir = config.mappings.dir;
  const git = (...args) => run('git', args, path.dirname(dir));
  let root;
  try {
    root = (await git('rev-parse', '--show-toplevel')).trim();
  } catch {
    log('warning: not a git repository - progress has only the current state');
    return { points: [await point(config, null, null)], events: [] };
  }
  const rel = path.relative(root, dir).split(path.sep).join('/') || '.';
  const gitRoot = (...args) => run('git', args, root);

  const log_ = (await gitRoot('log', '--reverse', '--format=%H%x09%cI%x09%s', '--', rel).catch(() => '')).trim();
  const commits = log_ ? log_.split('\n').map((l) => { const [sha, date, ...s] = l.split('\t'); return { sha, date, subject: s.join('\t') }; }) : [];

  const points = [];
  for (const c of commits) {
    const files = (await gitRoot('ls-tree', '-r', '--name-only', c.sha, '--', rel)).split('\n').filter((f) => f.endsWith('.json'));
    const maps = [];
    for (const f of files) {
      try {
        const res = parseConceptMap(await gitRoot('show', `${c.sha}:${f}`), f);
        if (res) maps.push({ file: path.posix.relative(rel, f), resource: res });
      } catch (err) {
        log(`  ${c.sha.slice(0, 7)} ${f}: ${err.message}`);
      }
    }
    points.push(await point(config, c, maps));
  }

  const dirty = (await gitRoot('status', '--porcelain', '--', rel)).trim();
  if (dirty || !points.length) points.push(await point(config, dirty ? { sha: null, date: new Date().toISOString(), subject: 'uncommitted changes' } : null, null));

  return { points, events: versionEvents(points) };
}

async function point(config, commit, maps) {
  const report = await runCompare(config, maps ? { maps } : {});
  const totals = (kind) => {
    // elements: all EHDS elements; mappedElements: only those of models that have a mapping
    const t = { models: 0, mappedModels: 0, elements: 0, mappedElements: 0, mapped: 0, noMap: 0, open: 0, remarks: 0 };
    for (const m of report.models.filter((x) => x.kind === kind)) {
      t.models++;
      t.elements += m.elementCount;
      // several Belgian targets for one EHDS model: count the most complete one
      const best = m.mappings.reduce((b, g) => (!b || g.counts.mapped + g.counts.noMap > b.counts.mapped + b.counts.noMap ? g : b), null);
      if (best) {
        t.mappedModels++;
        t.mappedElements += m.elementCount;
        t.mapped += best.counts.mapped;
        t.noMap += best.counts.noMap;
        t.open += best.counts.open;
      } else {
        t.open += m.elementCount;
      }
      t.remarks += m.remarkCount;
    }
    return t;
  };
  return {
    date: commit?.date ?? new Date().toISOString(),
    commit: commit?.sha ?? null,
    subject: commit?.subject ?? 'current state',
    logical: totals('logical'),
    profiles: totals('profile'),
    versions: report.models.flatMap((m) =>
      m.mappings.map((g) => ({ conceptMap: g.conceptMap.id, model: m.id, target: g.targetName, sourceVersion: g.sourceVersion ?? null, targetVersion: g.targetVersion ?? null })),
    ),
  };
}

/** A ConceptMap that starts or moves to another model version is an event on the chart. */
export function versionEvents(points) {
  const events = [];
  const last = new Map();
  for (const p of points) {
    for (const v of p.versions) {
      const prev = last.get(v.conceptMap);
      if (!prev) events.push({ date: p.date, commit: p.commit, conceptMap: v.conceptMap, text: `${v.model} → ${v.target} started${v.sourceVersion ? ` (EHDS ${v.sourceVersion}` : ''}${v.targetVersion ? `${v.sourceVersion ? ', ' : ' ('}BE ${v.targetVersion}` : ''}${v.sourceVersion || v.targetVersion ? ')' : ''}` });
      else {
        if (prev.sourceVersion !== v.sourceVersion) events.push({ date: p.date, commit: p.commit, conceptMap: v.conceptMap, text: `${v.model} → ${v.target}: EHDS model ${prev.sourceVersion ?? '?'} → ${v.sourceVersion ?? '?'}` });
        if (prev.targetVersion !== v.targetVersion) events.push({ date: p.date, commit: p.commit, conceptMap: v.conceptMap, text: `${v.model} → ${v.target}: Belgian model ${prev.targetVersion ?? '?'} → ${v.targetVersion ?? '?'}` });
      }
      last.set(v.conceptMap, v);
    }
  }
  return events;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}
