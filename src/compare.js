import { modelElements } from './catalog.js';
import { loadCompositions, placeModels, placeTargets } from './compositions.js';
import { readCatalog, readModel } from './fetch.js';
import { loadMappings, mappingGroups } from './mappings.js';

/**
 * Compare the EHDS models (and profiles) with the Belgian ones through the ConceptMaps.
 *   models  EHDS side: [{ entry, sd }]   (preferred variants)
 *   targets Belgian side: Map url -> { entry, sd }
 * Per EHDS model: the Belgian models it is mapped to, element coverage, the remarks,
 * and whether either model changed since the mapping was made.
 */
export function compare(models, groups, targets = new Map()) {
  const byUrl = new Map(models.map((m) => [m.entry.url, m]));
  const unknownSources = groups.filter((g) => !byUrl.has(g.source));

  const result = models.map(({ entry, sd }) => {
    const elements = modelElements(sd);
    const known = new Set(elements.flatMap((e) => [e.id, e.path]));
    const mappings = groups
      .filter((g) => g.source === entry.url)
      .map((g) => {
        const listed = new Map(g.elements.map((l) => [l.code, l]));
        const counts = { mapped: 0, noMap: 0, open: 0 };
        for (const e of elements) {
          const line = listed.get(e.id) ?? listed.get(e.path);
          if (!line || line.status === 'open') counts.open++;
          else if (line.status === 'mapped') counts.mapped++;
          else counts.noMap++;
        }
        const target = targets.get(g.target) ?? null;
        const targetKnown = target ? new Set(modelElements(target.sd).flatMap((e) => [e.id, e.path])) : null;
        const remarks = g.elements.flatMap((l) =>
          l.targets.filter((t) => t.comment).map((t) => ({ element: l.code, target: t.code, relationship: t.relationship, remark: t.comment })),
        );
        return {
          file: g.file,
          conceptMap: g.conceptMap,
          target: g.target,
          targetKey: target?.entry.key ?? null,
          targetName: target?.entry.name ?? g.target.split('/').pop(),
          targetFound: Boolean(target),
          counts,
          remarks,
          lines: g.elements,
          unknownElements: g.elements.map((l) => l.code).filter((c) => !known.has(c)),
          unknownTargets: targetKnown
            ? [...new Set(g.elements.flatMap((l) => l.targets.map((t) => t.code)).filter((c) => c && !targetKnown.has(c)))]
            : [],
          changes: changesSince(g, entry, target?.entry),
        };
      });
    return {
      key: entry.key,
      id: entry.id,
      kind: entry.kind,
      title: entry.title ?? entry.name,
      url: entry.url,
      version: entry.version,
      date: entry.date,
      elementCount: elements.length,
      mapped: mappings.length > 0,
      remarkCount: mappings.reduce((n, m) => n + m.remarks.length, 0),
      mappings,
    };
  });

  // mapped models first (most remarks first), then the unmapped ones alphabetically
  result.sort((a, b) => Number(b.mapped) - Number(a.mapped) || b.remarkCount - a.remarkCount || a.id.localeCompare(b.id));

  const summary = (kind) => {
    const ms = result.filter((m) => !kind || m.kind === kind);
    const all = ms.flatMap((m) => m.mappings);
    return {
      models: ms.length,
      mapped: ms.filter((m) => m.mapped).length,
      withRemarks: ms.filter((m) => m.remarkCount > 0).length,
      remarks: ms.reduce((n, m) => n + m.remarkCount, 0),
      conceptMaps: new Set(all.map((g) => g.file)).size,
      outdated: all.filter((g) => g.changes.length).length,
    };
  };

  return {
    summary: summary('logical'),
    profiles: summary('profile'),
    models: result,
    unknownSources: unknownSources.map((g) => ({ file: g.file, source: g.source, target: g.target })),
  };
}

/** What changed in either model since the mapping was made (versions, then dates vs ConceptMap.date). */
export function changesSince(group, source, target) {
  const changes = [];
  const check = (side, entry, mappedVersion) => {
    if (!entry) return;
    if (mappedVersion && entry.version && mappedVersion !== entry.version) {
      changes.push({ side, what: 'version', mapped: mappedVersion, now: entry.version });
    } else if (group.conceptMap.date && entry.date && Date.parse(entry.date) > Date.parse(group.conceptMap.date)) {
      changes.push({ side, what: 'date', mapped: group.conceptMap.date, now: entry.date });
    }
  };
  check('ehds', source, group.sourceVersion);
  check('be', target, group.targetVersion);
  return changes;
}

/** Load the catalog, the StructureDefinitions and the mappings, and compare. */
export async function runCompare(config, { maps } = {}) {
  const catalog = await readCatalog(config.output);
  const preferred = catalog.models.filter((m) => m.preferred);
  const load = async (entry) => ({ entry, sd: await readModel(config.output, entry) });
  const models = await Promise.all(preferred.filter((m) => m.side === 'ehds').map(load));
  const targets = new Map((await Promise.all(preferred.filter((m) => m.side === 'be').map(load))).map((t) => [t.entry.url, t]));
  const groups = mappingGroups(maps ?? (await loadMappings(config.mappings.dir)));
  const report = { ...compare(models, groups, targets), source: catalog.sides.ehds };
  return placeReport(report, models, await loadCompositions(config.compositions));
}

/** Add the compositions to a report: place on each EHDS model, the Belgian models mapped to them. */
export function placeReport(report, models, compositions) {
  const logical = models.filter((m) => m.entry.kind === 'logical');
  const { places, compositions: list, unknown } = placeModels(logical, compositions);
  const nameOf = new Map(models.map((m) => [m.entry.key, m.entry.name]));
  for (const m of report.models) m.place = places.get(nameOf.get(m.key)) ?? null;
  report.compositions = list;
  report.placedTargets = Object.fromEntries(placeTargets(report));
  report.unknownPlacements = unknown;
  return report;
}
