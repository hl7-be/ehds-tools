import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { packageDate } from './catalog.js';
import { parseGitHubUrl, publishedPackageUrls, repoInfo, sourceTarballUrl } from './github.js';
import { download, extractTgz, readFhirPackage, readResources } from './package-reader.js';

/**
 * The EHDS side: a GitHub repository with a FHIR IG. Reads the published package
 * (build.fhir.org, GitHub Pages) or builds the commit with SUSHI.
 * Returns { provenance, resources, pkg, source } for the catalog.
 */
export async function fetchEhds(ehds, { log = console.error, fetchImpl = fetch, runSushi = sushiBuild } = {}) {
  const { url, mode, packageUrl } = ehds;
  const gh = parseGitHubUrl(url);
  const ref = ehds.ref ?? gh.ref ?? null;

  const info = await repoInfo({ ...gh, ref }, { fetchImpl });
  if (info.warning) log(`warning: ${info.warning}`);
  const resolvedRef = ref ?? info.defaultBranch ?? 'main';

  let result;
  const attempts = [];
  if (mode !== 'source') {
    const candidates = packageUrl ? [packageUrl] : publishedPackageUrls({ ...gh, ref: resolvedRef, defaultBranch: info.defaultBranch });
    for (const candidate of candidates) {
      try {
        log(`EHDS: fetching published package ${candidate}`);
        const { manifest, resources } = await readFhirPackage(await download(candidate, { fetchImpl }));
        result = { mode: 'published', packageUrl: candidate, manifest, resources };
        break;
      } catch (err) {
        attempts.push(err.message);
        log(`  not usable: ${err.message}`);
      }
    }
    if (!result && mode === 'published') {
      throw new Error(`No published package found for ${url} @ ${resolvedRef}:\n  ${attempts.join('\n  ')}`);
    }
  }
  if (!result) {
    const tarball = sourceTarballUrl({ ...gh, ref: info.commit?.sha ?? resolvedRef });
    log(`EHDS: building from source ${tarball} with SUSHI`);
    result = { mode: 'source', sourceUrl: tarball, manifest: null, resources: await buildFromSource(tarball, { fetchImpl, runSushi, log }) };
  }

  const stale = staleness(result.manifest?.date, info.commit?.date);
  if (stale) log(`warning: ${stale} - use --mode source to build the latest commit`);

  const builtAt = packageDate(result.manifest?.date) ?? info.commit?.date ?? null;
  const provenance = {
    url,
    owner: gh.owner,
    repo: gh.repo,
    ref: resolvedRef,
    commit: info.commit,
    mode: result.mode,
    packageUrl: result.packageUrl ?? null,
    sourceUrl: result.sourceUrl ?? null,
    package: result.manifest
      ? { id: result.manifest.name, version: result.manifest.version, date: builtAt, fhirVersions: result.manifest.fhirVersions }
      : null,
    warnings: [info.warning, stale].filter(Boolean),
  };
  return {
    provenance,
    resources: result.resources,
    pkg: {
      id: result.manifest?.name ?? `${gh.owner}/${gh.repo}`,
      version: result.manifest?.version ?? null,
      label: 'EHDS',
      igUrl: result.manifest?.url ?? `https://build.fhir.org/ig/${gh.owner}/${gh.repo}/`,
      date: builtAt,
    },
    source: { type: result.mode === 'published' ? 'ci' : 'github', url, ref: resolvedRef, commit: info.commit?.sha ?? null },
  };
}

export function staleness(manifestDate, commitDate) {
  const built = packageDate(manifestDate);
  if (!built || !commitDate) return null;
  return Date.parse(commitDate) > Date.parse(built)
    ? `published package (built ${built}) is older than the latest commit (${commitDate})`
    : null;
}

async function buildFromSource(tarball, { fetchImpl, runSushi, log }) {
  const { dir, root } = await extractTgz(await download(tarball, { fetchImpl }), { strip: 1 });
  try {
    await runSushi(root, { log });
    return await readResources(path.join(root, 'fsh-generated', 'resources'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run `sushi build <dir>` (SUSHI from PATH, or the SUSHI environment variable). */
export function sushiBuild(dir, { log }) {
  const cmd = process.env.SUSHI ?? 'sushi';
  return new Promise((resolve, reject) => {
    const stdio = ['ignore', 'pipe', 'pipe'];
    // On Windows sushi is a .cmd shim and needs a shell; pass one command string (dir is our own temp path).
    const child = process.platform === 'win32'
      ? spawn(`${cmd} build "${dir}"`, { shell: true, stdio })
      : spawn(cmd, ['build', dir], { stdio });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => reject(new Error(`cannot run ${cmd} (install with: npm i -g fsh-sushi): ${err.message}`)));
    child.on('close', (code) => {
      const summary = output.split('\n').filter((l) => /errors?|warnings?/i.test(l)).slice(-3).join('\n');
      if (summary) log(summary);
      code === 0 ? resolve() : reject(new Error(`SUSHI exited with ${code}\n${output.slice(-2000)}`));
    });
  });
}
