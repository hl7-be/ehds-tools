/**
 * The catalog: one entry per fetched StructureDefinition, both sides, as the site and the
 * comparison read it (data/catalog.json). The StructureDefinition itself is in files.sd.
 */

/** logical | profile | null (extensions, base types and the like are not kept). */
export function classify(sd) {
  if (sd?.resourceType !== 'StructureDefinition') return null;
  if (sd.kind === 'logical') return 'logical';
  if (sd.derivation === 'constraint' && ['resource', 'complex-type'].includes(sd.kind) && sd.type !== 'Extension') return 'profile';
  return null;
}

/** Elements of a StructureDefinition, without the root. */
export function modelElements(sd) {
  const elements = sd.snapshot?.element ?? sd.differential?.element ?? [];
  return elements
    .filter((e) => (e.id ?? e.path).includes('.'))
    .map((e) => ({
      id: e.id ?? e.path,
      path: e.path,
      short: e.short ?? null,
      min: e.min,
      max: e.max,
      types: (e.type ?? []).map((t) => String(t.code).split('/').pop()),
    }));
}

/** Lifecycle stage, as in the CareSets tool; drives the diagram colour. */
export function stageOf(sd, source) {
  if (sd.status === 'retired') return 'deprecated';
  switch (source.type) {
    case 'release':
    case 'url':
      return 'published';
    case 'ci':
      return source.defaultBranch ? 'accepted' : 'draft';
    default:
      return 'draft'; // EHDS CI builds and SUSHI builds
  }
}

export const STAGE_LABELS = {
  draft: 'In draft',
  review: 'For review',
  reviewed: 'Reviewed',
  accepted: 'Accepted (main branch)',
  published: 'Published',
  deprecated: 'Deprecated',
  unknown: 'Unknown',
};

/** IG Publisher dates are yyyyMMddHHmmss (UTC). */
export function packageDate(d) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(d ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : d ?? null;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Build a catalog entry.
 *   side     'ehds' | 'be'
 *   pkg      { id, version, label, igUrl, date }
 *   source   { type, url, ref, commit, defaultBranch }
 */
export function entryFor(sd, { side, pkg, source, kind }) {
  const key = side === 'ehds' ? `ehds--${sd.id}` : `be--${slug(pkg.label)}--${slug(source.type)}--${sd.id}`;
  return {
    key,
    side,
    kind,
    id: sd.id,
    name: sd.name,
    title: sd.title ?? null,
    description: sd.description ?? null,
    url: sd.url,
    version: sd.version ?? pkg.version ?? null,
    // the date the publisher stamped on the resource, else the package build date
    date: sd.date ?? pkg.date ?? null,
    status: sd.status ?? null,
    stage: stageOf(sd, source),
    type: sd.type,
    baseDefinition: sd.baseDefinition ?? null,
    elementCount: modelElements(sd).length,
    package: { id: pkg.id ?? null, version: pkg.version ?? null, label: pkg.label, igUrl: pkg.igUrl ?? null },
    source,
    preferred: true,
    files: {
      sd: `${side}/models/${key}.json`,
      puml: `${side}/diagrams/${key}.puml`,
      svg: `${side}/diagrams/${key}.svg`,
    },
  };
}

/**
 * The same model (same canonical url) from several sources: the first one in config order
 * prevails, as with "Published wins" in the CareSets tool. Mutates `preferred` and `variants`.
 */
export function resolveVariants(entries) {
  const byUrl = new Map();
  for (const e of entries) {
    if (!byUrl.has(e.url)) byUrl.set(e.url, []);
    byUrl.get(e.url).push(e);
  }
  for (const group of byUrl.values()) {
    group.forEach((e, i) => {
      e.preferred = i === 0;
      e.variants = group.length > 1 ? group.map((v) => v.key) : undefined;
    });
  }
  return entries;
}
