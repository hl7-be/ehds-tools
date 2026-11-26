import { packageDate } from './catalog.js';
import { download, readFhirPackage } from './package-reader.js';

/**
 * The Belgian side, with the source kinds of the CareSets tool (caresets.json):
 *   release  packageId, version ('latest' or a specific one)  -> packages.fhir.org
 *   ci       from (a build.fhir.org address) or repo + branch  -> build.fhir.org
 *   url      one StructureDefinition JSON
 * Optional on any: package (grouping label), names (only these models).
 */

const REGISTRY = 'https://packages.fhir.org';
const BUILD = 'https://build.fhir.org/ig';
const DEFAULT_OWNER = 'hl7-be';

export function describe(entry) {
  switch (entry.kind) {
    case 'release':
      return `release ${entry.packageId}#${entry.version ?? 'latest'}`;
    case 'ci':
      return `ci ${entry.from ?? `${entry.owner ?? DEFAULT_OWNER}/${entry.repo}@${entry.branch ?? 'default'}`}`;
    case 'url':
      return `url ${entry.url}`;
    default:
      return `unknown kind ${entry.kind}`;
  }
}

/** build.fhir.org address -> owner, repo, branch ('' = default branch). Language folders are ignored. */
export function parseBuildUrl(url) {
  const m = /build\.fhir\.org\/ig\/([^/]+)\/([^/]+)(?:\/branches\/([^/]+))?/i.exec(String(url));
  return m ? { owner: m[1], repo: m[2], branch: m[3] ?? '' } : null;
}

const isDefaultBranch = (b) => !b || b === 'main' || b === 'master';

export function ciSiteUrl({ owner, repo, branch }) {
  const base = `${BUILD}/${owner}/${repo}`;
  return isDefaultBranch(branch) ? `${base}/` : `${base}/branches/${branch}/`;
}

/** Fetch one source. Returns { provenance, resources, pkg, source }. */
export async function fetchBelgianSource(entry, { fetchImpl = fetch, log = console.error } = {}) {
  log(`BE: ${describe(entry)}`);
  if (entry.kind === 'release') {
    let version = entry.version ?? 'latest';
    if (version === 'latest') {
      const r = await fetchImpl(`${REGISTRY}/${encodeURIComponent(entry.packageId)}`, { headers: { 'User-Agent': 'ehds-tools' } });
      if (!r.ok) throw new Error(`${entry.packageId}: registry HTTP ${r.status}`);
      const meta = await r.json();
      version = meta['dist-tags']?.latest ?? Object.keys(meta.versions ?? {}).pop();
      if (!version) throw new Error(`${entry.packageId}: no versions in the registry`);
    }
    const url = `${REGISTRY}/${encodeURIComponent(entry.packageId)}/${encodeURIComponent(version)}`;
    const { manifest, resources } = await readFhirPackage(await download(url, { fetchImpl }));
    return result(entry, manifest, resources, { type: 'release', url, version });
  }

  if (entry.kind === 'ci') {
    const where = entry.from ? parseBuildUrl(entry.from) : { owner: entry.owner ?? DEFAULT_OWNER, repo: entry.repo, branch: entry.branch ?? '' };
    if (!where?.repo) throw new Error(`ci source needs "from" (a build.fhir.org address) or "repo": ${JSON.stringify(entry)}`);
    const site = ciSiteUrl(where);
    const { manifest, resources } = await readFhirPackage(await download(`${site}package.tgz`, { fetchImpl }));
    return result(entry, manifest, resources, {
      type: 'ci',
      url: site,
      ref: where.branch || null,
      defaultBranch: isDefaultBranch(where.branch),
    }, site);
  }

  if (entry.kind === 'url') {
    const r = await fetchImpl(entry.url, { headers: { 'User-Agent': 'ehds-tools', Accept: 'application/fhir+json' } });
    if (!r.ok) throw new Error(`${entry.url}: HTTP ${r.status}`);
    const sd = await r.json();
    if (sd.resourceType !== 'StructureDefinition') throw new Error(`${entry.url}: not a StructureDefinition`);
    return result(entry, null, [sd], { type: 'url', url: entry.url });
  }

  throw new Error(`Unknown source kind "${entry.kind}" (use release, ci or url)`);
}

function result(entry, manifest, resources, source, igUrl) {
  const names = entry.names ? new Set(entry.names) : null;
  const kept = names ? resources.filter((r) => names.has(r.name) || names.has(r.id)) : resources;
  const label = entry.package ?? labelFor(manifest) ?? 'Belgian models';
  const date = packageDate(manifest?.date);
  return {
    provenance: {
      description: describe(entry),
      source,
      package: manifest ? { id: manifest.name, version: manifest.version, date, title: manifest.title ?? null } : null,
    },
    resources: kept,
    pkg: { id: manifest?.name ?? null, version: manifest?.version ?? null, label, igUrl: igUrl ?? manifest?.url ?? null, date },
    source,
  };
}

/** "hl7.fhir.be.core-clinical" -> "Core Clinical", as a grouping label. */
function labelFor(manifest) {
  if (!manifest?.name) return null;
  const last = manifest.name.replace(/^hl7\.fhir\.be\./, '');
  return last.split(/[-.]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
