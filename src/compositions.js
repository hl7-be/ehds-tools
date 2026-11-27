import { readFile } from 'node:fs/promises';

/**
 * Compositions: which EHDS models matter on their own (the focus of a composition, e.g. the
 * Patient Summary, the prescription, the dispense), which are their first-level sections, and
 * which are building blocks (components such as HumanName). Kept in compositions.json:
 *
 *   compositions  [{ id, title, focus: [model], sections: "auto" | [model | { title, models }] }]
 *                 "auto": the focus model's "Section: ..." elements and the models they contain
 *   components    [model]           building blocks, not shown among the models that matter
 *   tags          { model: [tag] }  free tags, for searching and analytics (either side)
 *
 * Every EHDS model gets one tier: focus > section > component > supporting (everything else).
 * A Belgian model takes the tier and compositions of the EHDS models mapped to it.
 */
export const TIERS = ['focus', 'section', 'supporting', 'component'];
export const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

export const EMPTY = { compositions: [], components: [], tags: {} };

export async function loadCompositions(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  return {
    compositions: (raw.compositions ?? []).map((c) => ({
      id: c.id,
      title: c.title ?? c.id,
      description: c.description ?? null,
      focus: [].concat(c.focus ?? []),
      sections: c.sections ?? 'auto',
    })),
    components: raw.components ?? [],
    tags: raw.tags ?? {},
  };
}

/** The "Section: ..." elements of a model and the models each one contains, in order. */
export function autoSections(sd, modelByUrl) {
  const elements = sd.snapshot?.element ?? sd.differential?.element ?? [];
  const root = elements[0]?.path?.split('.')[0];
  const sections = [];
  for (const e of elements) {
    const parts = e.path.split('.');
    if (parts.length !== 2 || parts[0] !== root || !/^\s*section\b/i.test(e.short ?? '')) continue;
    const title = (e.short ?? '').replace(/^\s*section\s*:?\s*/i, '').split(/\.\s/)[0].replace(/\.$/, '').trim() || parts[1];
    const models = [];
    for (const c of elements) {
      if (c.path.split('.').length !== 3 || !c.path.startsWith(`${e.path}.`)) continue;
      for (const name of modelTypes(c, modelByUrl)) if (!models.includes(name)) models.push(name);
    }
    sections.push({ title, element: e.path, models });
  }
  return sections;
}

function modelTypes(element, modelByUrl) {
  const out = [];
  for (const t of element.type ?? []) {
    for (const u of [t.code, ...(t.profile ?? []), ...(t.targetProfile ?? [])]) {
      const name = modelByUrl.get(u);
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Place the EHDS models: [{ entry, sd }] -> Map name -> place
 *   place = { tier, compositions: [{ id, role: 'focus'|'section', section, order }], tags }
 * Also returns the compositions with their resolved members, and names that were configured
 * but are not among the models (so a renamed model shows up as a problem, not silently).
 */
export function placeModels(models, config = EMPTY) {
  const byName = new Map(models.map((m) => [m.entry.name, m]));
  const byId = new Map(models.map((m) => [m.entry.id, m]));
  const modelByUrl = new Map(models.map((m) => [m.entry.url, m.entry.name]));
  const resolve = (ref) => (byName.get(ref) ?? byId.get(ref))?.entry.name ?? null;
  const unknown = new Set();
  const known = (ref) => {
    const name = resolve(ref);
    if (!name) unknown.add(ref);
    return name;
  };

  const places = new Map(
    models.map((m) => [m.entry.name, { tier: 'supporting', compositions: [], tags: [...(config.tags[m.entry.name] ?? config.tags[m.entry.id] ?? [])] }]),
  );
  const setTier = (name, tier) => {
    const p = places.get(name);
    if (TIER_RANK[tier] < TIER_RANK[p.tier]) p.tier = tier;
  };
  for (const c of config.components) {
    const name = known(c);
    if (name) places.get(name).tier = 'component';
  }

  const compositions = [];
  for (const c of config.compositions) {
    const focus = c.focus.map(known).filter(Boolean);
    let sections;
    if (c.sections === 'auto') {
      sections = focus.flatMap((f) => autoSections(byName.get(f).sd, modelByUrl));
    } else {
      sections = [].concat(c.sections ?? []).map((s) =>
        typeof s === 'string'
          ? { title: resolve(s) ?? s, models: [known(s)].filter(Boolean) }
          : { title: s.title, models: [].concat(s.models ?? []).map(known).filter(Boolean) },
      );
    }
    let order = 0;
    const members = [];
    // a model in several sections (Observation) is listed once, with every section named
    const add = (name, role, section) => {
      const seen = members.find((m) => m.name === name);
      if (!seen) members.push({ name, role, section, order: order++ });
      else if (section && seen.role === 'section' && !seen.section.split(', ').includes(section)) seen.section += `, ${section}`;
    };
    for (const f of focus) add(f, 'focus', null);
    for (const s of sections) for (const name of s.models) add(name, 'section', s.title);
    for (const m of members) {
      places.get(m.name).compositions.push({ id: c.id, role: m.role, section: m.section, order: m.order });
      setTier(m.name, m.role);
    }
    compositions.push({ id: c.id, title: c.title, description: c.description, focus, sections: sections.map((s) => ({ title: s.title, models: s.models })), members });
  }

  return { places, compositions, unknown: [...unknown] };
}

/**
 * A Belgian model takes the best tier and the compositions of the EHDS models mapped to it.
 * report: compare() output, with place on each EHDS model.
 */
export function placeTargets(report) {
  const out = new Map();
  for (const m of report.models) {
    if (!m.place) continue;
    for (const g of m.mappings) {
      if (!g.targetKey) continue;
      const p = out.get(g.targetKey) ?? { tier: m.place.tier, compositions: [], from: [] };
      if (TIER_RANK[m.place.tier] < TIER_RANK[p.tier]) p.tier = m.place.tier;
      for (const c of m.place.compositions) if (!p.compositions.some((x) => x.id === c.id && x.section === c.section)) p.compositions.push(c);
      if (!p.from.includes(m.id)) p.from.push(m.id);
      out.set(g.targetKey, p);
    }
  }
  return out;
}
