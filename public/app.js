// EHDS Models - static, read-only site with the layout of the CareSets tool.
// Reads data/catalog.json, data/comparison.json and data/progress.json, written by `ehds-tools site`.

const STAGES = {
  draft: { label: 'In draft', color: '#F7EFB5' },
  review: { label: 'For review', color: '#F7EFB5' },
  reviewed: { label: 'Reviewed', color: '#F7EFB5' },
  accepted: { label: 'Accepted (main)', color: '#F7EFB5' },
  published: { label: 'Published', color: '#B5E8F7' },
  deprecated: { label: 'Deprecated', color: '#F7D6B5' },
  unknown: { label: 'Unknown', color: '#E6E6E6' },
};
const SIDES = { ehds: 'EHDS', be: 'Belgian' };
const KINDS = { logical: 'Logical models', profile: 'Profiles' };
const DIAGRAM_LABELS = { modelgram: 'PlantUML (modelgram)', uml: 'UML class diagram' };

const state = { catalog: null, comparison: null, progress: null, byKey: new Map(), compareByKey: new Map(), targetIndex: new Map() };
const ui = {
  view: 'models',
  search: '',
  sides: new Set(['ehds', 'be']),
  kinds: new Set(['logical']),
  groupBy: 'package',
  layout: 'table',
  diagram: 'modelgram',
  variantShow: 'preferred',
  sort: { key: 'name', dir: 1 },
  mapSearch: '',
  mapFilter: 'all', // all | mapped | remarks | outdated | unmapped
  progressScope: 'all', // all | mapped: denominator of the progress chart
};

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  return node;
};

function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function fmtDay(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const dataUrl = (p) => (p ? `data/${p}` : null);

async function getJson(path, fallback) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 9000 : 4200);
}

function stageBadge(stage) {
  const s = STAGES[stage] ?? STAGES.unknown;
  return el('span', { class: 'stage-badge', style: { background: s.color }, text: s.label });
}

function sourceLabel(source) {
  if (!source) return '—';
  if (source.type === 'release') return `release ${source.version ?? ''}`.trim();
  if (source.type === 'ci') return source.ref ? `ci ${source.ref}` : 'ci';
  if (source.type === 'github') return `source ${source.ref ?? ''}`.trim();
  return source.type;
}

function svgUrl(entry, kind = ui.diagram) {
  return dataUrl(entry.diagrams?.[kind]?.svg);
}

// ---------------------------------------------------------------- boot

async function boot() {
  wireTabs();
  wireDrawer();
  try {
    state.catalog = await getJson('data/catalog.json');
  } catch (err) {
    setChildren(document.getElementById('models-body'), el('div', { class: 'empty' }, el('h3', { text: 'No data' }), el('p', { text: `Run "ehds-tools site" first (${err.message}).` })));
    return;
  }
  state.comparison = await getJson('data/comparison.json', { models: [], summary: {}, profiles: {}, unknownSources: [] });
  state.progress = await getJson('data/progress.json', { points: [], events: [] });

  for (const m of state.catalog.models) state.byKey.set(m.key, m);
  for (const c of state.comparison.models) {
    state.compareByKey.set(c.key, c);
    for (const g of c.mappings) {
      if (!g.targetKey) continue;
      if (!state.targetIndex.has(g.targetKey)) state.targetIndex.set(g.targetKey, []);
      state.targetIndex.get(g.targetKey).push({ model: c, mapping: g });
    }
  }

  renderEnv();
  wireModelsToolbar();
  wireMappingsToolbar();
  render();
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

function renderEnv() {
  const s = state.catalog.sides.ehds;
  const be = state.catalog.sides.be ?? [];
  const failed = be.filter((b) => b.error);
  setChildren(
    document.getElementById('env'),
    s
      ? el('a', { class: 'pill ok', href: s.url, target: '_blank', rel: 'noreferrer', title: `${s.url} @ ${s.ref}`, text: `EHDS ${s.package?.version ?? s.ref}${s.commit ? ` · ${s.commit.sha.slice(0, 7)}` : ''}` })
      : null,
    el('span', { class: `pill ${failed.length ? 'warn' : 'ok'}`, title: be.map((b) => `${b.description}${b.error ? ` — ${b.error}` : ''}`).join('\n'), text: `BE ${be.length - failed.length}/${be.length} packages` }),
    el('span', { class: 'pill', title: 'When the data was fetched', text: `fetched ${fmtDay(state.catalog.generatedAt)}` }),
  );
}

function wireTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
}

function showView(view) {
  ui.view = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t.dataset.view === view);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('is-active', v.id === `view-${view}`);
  render();
}

function render() {
  if (ui.view === 'models') renderModels();
  if (ui.view === 'mappings') renderMappings();
  if (ui.view === 'progress') renderProgress();
  if (ui.view === 'profiles') renderProfiles();
}

// ---------------------------------------------------------------- models view

function drawChips() {
  const count = (which, key) =>
    state.catalog.models.filter((m) => m.preferred && (which === 'side' ? m.side === key : m.kind === key)).length;
  const chips = (host, options, set, which) =>
    setChildren(
      host,
      ...Object.entries(options).map(([key, label]) =>
        el('button', {
          class: `chip${set.has(key) ? ' is-on' : ''}`,
          text: `${label} ${count(which, key)}`,
          onclick: () => {
            set.has(key) ? set.delete(key) : set.add(key);
            drawChips();
            renderModels();
          },
        }),
      ),
    );
  chips(document.getElementById('side-filter'), SIDES, ui.sides, 'side');
  chips(document.getElementById('kind-filter'), KINDS, ui.kinds, 'kind');
}

function wireModelsToolbar() {
  drawChips();

  const bind = (id, key) => {
    const node = document.getElementById(id);
    node.value = ui[key];
    node.addEventListener(node.tagName === 'INPUT' ? 'input' : 'change', () => {
      ui[key] = node.value.trim ? node.value.trim() : node.value;
      renderModels();
    });
  };
  bind('search', 'search');
  bind('group-by', 'groupBy');
  bind('layout', 'layout');
  bind('diagram-kind', 'diagram');
  bind('variant-show', 'variantShow');

  setChildren(
    document.getElementById('legend'),
    ...[['published', 'Published'], ['draft', 'Draft / accepted'], ['deprecated', 'Deprecated']].map(([k, label]) =>
      el('span', {}, el('i', { class: 'swatch', style: { background: STAGES[k].color, display: 'inline-block', width: '11px', height: '11px', borderRadius: '3px', marginRight: '5px', border: '1px solid rgba(30,50,70,.2)' } }), label),
    ),
  );
}

function visibleModels() {
  const q = ui.search.toLowerCase();
  return state.catalog.models.filter(
    (m) =>
      (ui.variantShow === 'all' || m.preferred) &&
      ui.sides.has(m.side) &&
      ui.kinds.has(m.kind) &&
      (!q || [m.name, m.title, m.package?.label, m.id, m.url].some((v) => v && v.toLowerCase().includes(q))),
  );
}

const SORTERS = {
  name: (m) => m.name.toLowerCase(),
  package: (m) => m.package?.label ?? '',
  stage: (m) => m.stage,
  elementCount: (m) => m.elementCount,
  version: (m) => m.version ?? '',
  date: (m) => m.date ?? '',
  mapping: (m) => mappingScore(m),
};

function groupKey(m) {
  if (ui.groupBy === 'package') return m.package?.label === SIDES[m.side] ? SIDES[m.side] : `${SIDES[m.side]} · ${m.package?.label ?? '—'}`;
  if (ui.groupBy === 'side') return SIDES[m.side];
  if (ui.groupBy === 'stage') return (STAGES[m.stage] ?? STAGES.unknown).label;
  return '';
}

function renderModels() {
  const host = document.getElementById('models-body');
  const models = visibleModels();
  if (!models.length) return setChildren(host, el('div', { class: 'empty' }, el('h3', { text: 'Nothing matches that filter' })));

  const sorter = SORTERS[ui.sort.key] ?? SORTERS.name;
  const sorted = [...models].sort((a, b) => {
    const av = sorter(a);
    const bv = sorter(b);
    if (av < bv) return -ui.sort.dir;
    if (av > bv) return ui.sort.dir;
    return a.name.localeCompare(b.name);
  });
  const groups = new Map();
  for (const m of sorted) {
    const k = groupKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  // EHDS first, then Belgian packages alphabetically
  const order = (a, b) => (a[0].startsWith('EHDS') === b[0].startsWith('EHDS') ? a[0].localeCompare(b[0]) : a[0].startsWith('EHDS') ? -1 : 1);
  setChildren(
    host,
    ...[...groups.entries()].sort(order).map(([key, items]) =>
      el('section', { class: 'group' }, key ? groupHead(key, items) : null, ui.layout === 'gallery' ? gallery(items) : table(items)),
    ),
  );
}

function groupHead(key, models) {
  const ig = models.find((m) => m.package?.igUrl)?.package;
  return el(
    'div',
    { class: 'group-head' },
    el('h2', {}, ig?.igUrl && ui.groupBy === 'package'
      ? el('a', { href: ig.igUrl, target: '_blank', rel: 'noreferrer', class: 'ig-link', title: `${ig.id ?? ''} ${ig.version ?? ''} — ${ig.igUrl}` }, key, el('span', { class: 'ig-arrow', text: '↗' }))
      : key),
    el('span', { class: 'group-count', text: String(models.length) }),
    ig?.version && ui.groupBy === 'package' ? el('span', { class: 'group-ig-title', text: `${ig.id ?? ''} ${ig.version}` }) : null,
  );
}

const COLUMNS = [
  { key: 'name', label: 'Model' },
  { key: 'package', label: 'Package' },
  { key: 'stage', label: 'Status' },
  { key: 'elementCount', label: 'Elements', class: 'num' },
  { key: 'version', label: 'Version' },
  { key: 'date', label: 'Date' },
  { key: 'mapping', label: 'Mapping' },
  { key: null, label: '' },
];

function table(models) {
  const cols = COLUMNS.filter((c) => !(ui.groupBy === 'package' && c.key === 'package'));
  const head = el(
    'tr',
    {},
    ...cols.map((col) =>
      el(
        'th',
        {
          class: [col.class, col.key ? '' : 'no-sort'].filter(Boolean).join(' '),
          onclick: col.key
            ? () => {
                ui.sort = ui.sort.key === col.key ? { key: col.key, dir: -ui.sort.dir } : { key: col.key, dir: 1 };
                renderModels();
              }
            : null,
        },
        col.label,
        col.key && ui.sort.key === col.key ? el('span', { class: 'arrow', text: ui.sort.dir > 0 ? ' ▲' : ' ▼' }) : null,
      ),
    ),
  );
  return el('table', {}, el('thead', {}, head), el('tbody', {}, ...models.map((m) => row(m, cols))));
}

function subtitle(m) {
  if (m.title && m.title !== m.name) return m.title;
  if (m.description) return m.description.length > 90 ? `${m.description.slice(0, 88)}…` : m.description;
  return '';
}

function row(m, cols) {
  const cells = {
    name: el(
      'td',
      {},
      el(
        'div',
        { class: 'cell-model' },
        el('div', { class: 'thumb', style: { backgroundImage: svgUrl(m) ? `url("${svgUrl(m)}")` : 'none' }, title: 'Open the details', onclick: () => openModel(m.key) }),
        el(
          'div',
          {},
          el('div', { class: 'model-name' }, m.name, el('span', { class: 'side-badge', text: m.side.toUpperCase() }), m.kind === 'profile' ? el('span', { class: 'kind-badge', text: `profile of ${m.type}` }) : null,
            m.variants && ui.variantShow === 'all' ? el('span', { class: `variant-badge${m.preferred ? '' : ' is-superseded'}`, text: m.preferred ? `${m.variants.length} variants` : 'superseded' }) : null),
          el('div', { class: 'model-title', text: subtitle(m) }),
        ),
      ),
    ),
    package: el('td', {}, m.package?.label ?? '—'),
    stage: el('td', {}, stageBadge(m.stage)),
    elementCount: el('td', { class: 'num', text: m.elementCount ?? '—' }),
    version: el('td', { text: m.version ?? '—' }),
    date: el('td', { class: 'muted', text: fmtDay(m.date) }),
    mapping: el('td', {}, mappingCell(m)),
    null: el('td', {}, el('div', { class: 'actions' }, el('button', { class: 'btn btn-sm', text: 'Open', onclick: () => openModel(m.key) }))),
  };
  return el('tr', { class: m.preferred ? null : 'is-superseded' }, ...cols.map((c) => cells[c.key]));
}

/** EHDS: how far its best mapping is; Belgian: how many EHDS models map to it. */
function mappingScore(m) {
  if (m.side === 'ehds') {
    const c = state.compareByKey.get(m.key);
    const best = bestMapping(c);
    return best ? (best.counts.mapped + best.counts.noMap) / Math.max(1, c.elementCount) : -1;
  }
  return (state.targetIndex.get(m.key) ?? []).length;
}

function bestMapping(c) {
  return c?.mappings.reduce((b, g) => (!b || g.counts.mapped + g.counts.noMap > b.counts.mapped + b.counts.noMap ? g : b), null) ?? null;
}

function mappingCell(m) {
  if (m.side === 'ehds') {
    const c = state.compareByKey.get(m.key);
    const best = bestMapping(c);
    if (!best) return el('span', { class: 'map-cell muted', text: '—' });
    return el('span', { class: 'map-cell', title: `${best.counts.mapped} mapped, ${best.counts.noMap} no equivalent, ${best.counts.open} open` },
      progressBar(best.counts, c.elementCount), `${pct(best.counts.mapped + best.counts.noMap, c.elementCount)}% → ${best.targetName}`,
      c.mappings.length > 1 ? ` +${c.mappings.length - 1}` : '');
  }
  const from = state.targetIndex.get(m.key) ?? [];
  return from.length ? el('span', { class: 'map-cell', text: `from ${from.map((f) => f.model.id).join(', ')}` }) : el('span', { class: 'map-cell muted', text: '—' });
}

function progressBar(counts, total) {
  return el('span', { class: 'bar', 'aria-hidden': 'true' },
    el('span', { class: 'b-mapped', style: { width: `${pct(counts.mapped, total)}%` } }),
    el('span', { class: 'b-nomap', style: { width: `${pct(counts.noMap, total)}%` } }));
}

function gallery(models) {
  return el(
    'div',
    { class: 'gallery' },
    ...models.map((m) =>
      el(
        'article',
        { class: 'card' },
        el('div', { class: 'card-figure', title: 'Open the details', onclick: () => openModel(m.key) },
          svgUrl(m) ? el('img', { src: svgUrl(m), alt: `${m.name} diagram`, loading: 'lazy' }) : el('span', { class: 'muted', text: 'no diagram' })),
        el(
          'div',
          { class: 'card-body' },
          el('div', { class: 'model-name' }, m.name, el('span', { class: 'side-badge', text: m.side.toUpperCase() })),
          el('div', { class: 'model-title', text: subtitle(m) }),
          el('div', { class: 'row-between' }, stageBadge(m.stage), mappingCell(m)),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- drawer

function wireDrawer() {
  const drawer = document.getElementById('drawer');
  drawer.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

function closeDrawer() {
  document.getElementById('drawer').hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function openFromHash() {
  const [kind, key, extra] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (kind === 'progress' && ['all', 'mapped'].includes(key)) ui.progressScope = key;
  if (['models', 'mappings', 'progress', 'profiles'].includes(kind)) return showView(kind);
  if (kind === 'model' && state.byKey.has(key)) openModel(key, { view: extra });
  if (kind === 'mapping') openMapping(key, extra);
}

const SD_CACHE = new Map();
async function loadSd(entry) {
  if (!SD_CACHE.has(entry.key)) SD_CACHE.set(entry.key, getJson(dataUrl(entry.files.sd)));
  return SD_CACHE.get(entry.key);
}

async function loadText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

let drawerView = 'tree';

async function openModel(key, { view } = {}) {
  const m = state.byKey.get(key);
  if (!m) return;
  if (view) drawerView = view;
  history.replaceState(null, '', `#model/${encodeURIComponent(key)}`);
  const drawer = document.getElementById('drawer');
  const content = document.getElementById('drawer-content');
  drawer.hidden = false;
  const sd = await loadSd(m);
  const c = state.compareByKey.get(m.key);
  const lineIndex = treeMappingIndex(m, c);

  const viewHost = el('div');
  const views = {
    tree: 'Tree view',
    modelgram: DIAGRAM_LABELS.modelgram,
    uml: DIAGRAM_LABELS.uml,
    puml: 'PlantUML source',
    json: 'JSON',
  };
  const tabs = el('div', { class: 'subtabs view-tabs' });
  const show = async (v) => {
    drawerView = v;
    for (const b of tabs.children) b.classList.toggle('is-active', b.dataset.v === v);
    setChildren(viewHost, el('p', { class: 'muted', text: 'Loading…' }));
    try {
      setChildren(viewHost, await renderModelView(m, sd, v, lineIndex));
    } catch (err) {
      setChildren(viewHost, el('p', { class: 'notice problem', text: err.message }));
    }
  };
  for (const [v, label] of Object.entries(views)) tabs.append(el('button', { class: 'subtab', 'data-v': v, text: label, onclick: () => show(v) }));

  setChildren(
    content,
    el('h2', {}, m.name, el('span', { class: 'side-badge', text: m.side.toUpperCase() })),
    m.title && m.title !== m.name ? el('p', { class: 'model-title', text: m.title }) : null,
    m.description ? el('p', { class: 'panel-intro', text: m.description }) : null,
    el('div', {}, stageBadge(m.stage), ' ', el('span', { class: 'src-badge', text: sourceLabel(m.source) })),
    tabs,
    viewHost,
    mappingsOfModel(m, c),
    el('h3', { class: 'section-head', text: 'Details' }),
    detailsList(m),
  );
  await show(views[drawerView] ? drawerView : 'tree');
}

/** element id -> status of its mapping line (EHDS: best mapping; Belgian: any line pointing at it). */
function treeMappingIndex(m, c) {
  const index = new Map();
  if (m.side === 'ehds') {
    const best = bestMapping(c);
    for (const l of best?.lines ?? []) index.set(l.code, { status: l.status, to: l.targets.map((t) => t.code).filter(Boolean).join(', ') });
  } else {
    for (const { model, mapping } of state.targetIndex.get(m.key) ?? []) {
      for (const l of mapping.lines) for (const t of l.targets) if (t.code) index.set(t.code, { status: 'mapped', to: `${model.id}: ${l.code}` });
    }
  }
  return index;
}

async function renderModelView(m, sd, v, lineIndex) {
  if (v === 'tree') return treeView(sd, lineIndex);
  if (v === 'modelgram' || v === 'uml') {
    const d = m.diagrams?.[v];
    if (!d?.svg) return el('p', { class: 'notice problem', text: d?.error ?? 'No diagram rendered' });
    return el('div', {},
      el('div', { class: 'figure-tools' },
        el('a', { class: 'btn btn-sm', href: dataUrl(d.svg), target: '_blank', rel: 'noreferrer', text: 'Open SVG' }),
        el('a', { class: 'btn btn-sm', href: dataUrl(d.puml), download: `${m.name}.${v}.puml`, text: 'Download .puml' })),
      el('div', { class: 'drawer-figure' }, el('img', { src: dataUrl(d.svg), alt: `${m.name} ${DIAGRAM_LABELS[v]}` })));
  }
  if (v === 'puml') {
    const parts = [];
    for (const kind of ['modelgram', 'uml']) {
      const d = m.diagrams?.[kind];
      if (!d?.puml) continue;
      parts.push(el('h3', { class: 'section-head', text: DIAGRAM_LABELS[kind] }),
        el('div', { class: 'figure-tools' }, el('a', { class: 'btn btn-sm', href: dataUrl(d.puml), download: `${m.name}.${kind}.puml`, text: 'Download .puml' })),
        el('pre', { class: 'puml-source', text: await loadText(dataUrl(d.puml)) }));
    }
    return el('div', {}, ...parts);
  }
  return el('div', {},
    el('div', { class: 'figure-tools' }, el('a', { class: 'btn btn-sm', href: dataUrl(m.files.sd), download: `${m.id}.json`, text: 'Download JSON' })),
    el('pre', { class: 'puml-source', text: JSON.stringify(sd, null, 2) }));
}

/** Element hierarchy, expandable; mapping status per element when there is one. */
function treeView(sd, lineIndex) {
  const elements = sd.snapshot?.element ?? sd.differential?.element ?? [];
  const nodes = new Map();
  const root = { children: [] };
  for (const e of elements) {
    const id = e.id ?? e.path;
    const node = { e, id, children: [] };
    nodes.set(id, node);
    const parent = id.includes('.') ? nodes.get(id.slice(0, id.lastIndexOf('.'))) : null;
    (parent ?? root).children.push(node);
  }
  const types = (e) =>
    (e.type ?? [])
      .map((t) => {
        const code = String(t.code).split('/').pop();
        return t.targetProfile?.length ? `${code}(${t.targetProfile.map((p) => p.split('/').pop()).join(' | ')})` : code;
      })
      .join(' | ');
  const line = (n) => {
    const e = n.e;
    const name = (n.id.split('.').pop() ?? n.id);
    const map = lineIndex.get(n.id) ?? lineIndex.get(e.path);
    return [
      el('span', { class: 't-name', text: name }),
      n.id.includes('.') ? el('span', { class: 't-card', text: `${e.min ?? 0}..${e.max ?? '*'}` }) : null,
      types(e) ? el('span', { class: 't-type', text: types(e) }) : null,
      e.short ? el('span', { class: 't-short', text: e.short }) : null,
      map && map.status !== 'open' ? el('span', { class: `t-map ${map.status}`, title: map.to || 'no Belgian equivalent', text: map.status === 'mapped' ? `→ ${map.to}` : 'no equivalent' }) : null,
    ];
  };
  const item = (n, depth) =>
    n.children.length
      ? el('li', {}, el('details', { open: depth < 2 }, el('summary', {}, ...line(n)), el('ul', {}, ...n.children.map((c) => item(c, depth + 1)))))
      : el('li', {}, el('span', { class: 'leaf' }), ...line(n));
  return el('div', { class: 'tree' }, el('ul', {}, ...root.children.map((n) => item(n, 0))));
}

function mappingsOfModel(m, c) {
  const rows = [];
  if (m.side === 'ehds') for (const g of c?.mappings ?? []) rows.push({ model: c, mapping: g });
  else rows.push(...(state.targetIndex.get(m.key) ?? []));
  return el('div', {},
    el('h3', { class: 'section-head', text: 'Mappings' }),
    rows.length
      ? mappingTable(rows)
      : el('p', { class: 'muted', text: m.side === 'ehds' ? 'No mapping to a Belgian model yet.' : 'No EHDS model is mapped to this model yet.' }));
}

function detailsList(m) {
  return el(
    'dl',
    { class: 'meta' },
    ...[
      ['Title', m.title ?? '—'],
      ['Kind', m.kind === 'profile' ? `Profile of ${m.type}` : 'Logical model'],
      ['Package', `${m.package?.label ?? '—'}${m.package?.id ? ` (${m.package.id}${m.package.version ? `#${m.package.version}` : ''})` : ''}`],
      ['Elements', String(m.elementCount ?? '—')],
      ['Version', m.version ?? '—'],
      ['Date', fmtDate(m.date)],
      ['Canonical', m.url],
      ['Base', m.baseDefinition ?? '—'],
      ['Source', `${sourceLabel(m.source)}${m.source?.url ? ` — ${m.source.url}` : ''}`],
      ['Resource status', m.status ?? '—'],
      ['Variants', m.variants ? `${m.variants.length} (${m.preferred ? 'this one prevails' : 'superseded'})` : '—'],
    ].flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v)]),
  );
}

// ---------------------------------------------------------------- mappings view

function wireMappingsToolbar() {
  const search = document.getElementById('map-search');
  search.addEventListener('input', () => {
    ui.mapSearch = search.value.trim().toLowerCase();
    renderMappings();
  });
  const filters = { all: 'All', mapped: 'Mapped', remarks: 'With remarks', outdated: 'Model changed', unmapped: 'Not mapped' };
  const host = document.getElementById('map-filter');
  const draw = () =>
    setChildren(host, ...Object.entries(filters).map(([k, label]) =>
      el('button', { class: `chip${ui.mapFilter === k ? ' is-on' : ''}`, text: label, onclick: () => { ui.mapFilter = k; draw(); renderMappings(); } })));
  draw();
}

function mappingRows(kind) {
  const q = ui.mapSearch;
  return state.comparison.models
    .filter((c) => c.kind === kind)
    .filter((c) => !q || c.id.toLowerCase().includes(q) || c.mappings.some((g) => g.targetName.toLowerCase().includes(q)))
    .filter((c) => {
      switch (ui.mapFilter) {
        case 'mapped': return c.mapped;
        case 'remarks': return c.remarkCount > 0;
        case 'outdated': return c.mappings.some((g) => g.changes.length);
        case 'unmapped': return !c.mapped;
        default: return true;
      }
    })
    .flatMap((c) => (c.mappings.length ? c.mappings.map((g) => ({ model: c, mapping: g })) : [{ model: c, mapping: null }]));
}

function renderMappings() {
  const s = state.comparison.summary;
  document.getElementById('map-summary').textContent =
    `${s.mapped ?? 0} of ${s.models ?? 0} EHDS models mapped · ${s.withRemarks ?? 0} with remarks (${s.remarks ?? 0}) · ${s.outdated ?? 0} made against an older model`;
  const rows = mappingRows('logical');
  const problems = mappingProblems();
  setChildren(
    document.getElementById('mappings-body'),
    problems.length ? el('div', { class: 'notice problem' }, el('strong', { text: 'Problems' }), el('ul', {}, ...problems.map((p) => el('li', { text: p })))) : null,
    rows.length ? mappingTable(rows) : el('div', { class: 'empty' }, el('h3', { text: 'Nothing matches that filter' })),
    remarksSection(rows),
  );
}

function mappingProblems() {
  const out = [];
  for (const c of state.comparison.models)
    for (const g of c.mappings) {
      if (g.unknownElements.length) out.push(`${g.file}: elements not in ${c.id}: ${g.unknownElements.join(', ')}`);
      if (!g.targetFound) out.push(`${g.file}: Belgian model ${g.target} was not fetched`);
      if (g.unknownTargets.length) out.push(`${g.file}: elements not in ${g.targetName}: ${g.unknownTargets.join(', ')}`);
    }
  for (const u of state.comparison.unknownSources ?? []) out.push(`${u.file}: source ${u.source} is not one of the fetched EHDS models`);
  return out;
}

function mappingTable(rows) {
  const head = el('tr', {}, ...['EHDS model', 'Belgian model', 'Progress', 'Mapped', 'No equivalent', 'Open', 'Remarks', 'Model changed', ''].map((h, i) => el('th', { class: `no-sort${i >= 3 && i <= 6 ? ' num' : ''}`, text: h })));
  const body = rows.map(({ model: c, mapping: g }) => {
    if (!g) {
      return el('tr', { class: 'is-superseded' },
        el('td', {}, el('a', { href: `#model/${encodeURIComponent(c.key)}`, text: c.id })), el('td', { text: '—' }),
        el('td', {}, progressBar({ mapped: 0, noMap: 0 }, 1)), el('td', { class: 'num' }), el('td', { class: 'num' }),
        el('td', { class: 'num', text: c.elementCount }), el('td'), el('td'), el('td'));
    }
    return el('tr', {},
      el('td', {}, el('a', { href: `#model/${encodeURIComponent(c.key)}`, text: c.id })),
      el('td', {}, g.targetKey ? el('a', { href: `#model/${encodeURIComponent(g.targetKey)}`, text: g.targetName }) : el('span', { title: g.target, text: `${g.targetName} (not fetched)` })),
      el('td', {}, el('span', { class: 'map-cell' }, progressBar(g.counts, c.elementCount), `${pct(g.counts.mapped + g.counts.noMap, c.elementCount)}%`)),
      el('td', { class: 'num', text: g.counts.mapped }),
      el('td', { class: 'num', text: g.counts.noMap }),
      el('td', { class: 'num', text: g.counts.open }),
      el('td', { class: 'num', text: g.remarks.length || '' }),
      el('td', { class: 'map-cell', title: changesText(g.changes), text: g.changes.length ? g.changes.map((x) => (x.side === 'ehds' ? 'EHDS' : 'BE')).join(', ') : '' }),
      el('td', {}, el('button', { class: 'btn btn-sm', text: 'Open', onclick: () => openMapping(c.key, g.conceptMap.id) })));
  });
  return el('table', {}, el('thead', {}, head), el('tbody', {}, ...body));
}

function changesText(changes) {
  return changes
    .map((x) => `${x.side === 'ehds' ? 'EHDS' : 'Belgian'} model ${x.what === 'version' ? `version ${x.mapped} → ${x.now}` : `changed ${fmtDay(x.now)}, after the mapping (${fmtDay(x.mapped)})`}`)
    .join('\n');
}

function remarksSection(rows) {
  const withRemarks = rows.filter((r) => r.mapping?.remarks.length);
  if (!withRemarks.length) return null;
  return el('div', {},
    el('h3', { class: 'section-head', text: 'Remarks' }),
    ...withRemarks.map(({ model: c, mapping: g }) =>
      el('div', { class: 'group' },
        el('div', { class: 'group-head' }, el('h2', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openMapping(c.key, g.conceptMap.id); }, text: `${c.id} → ${g.targetName}` })), el('span', { class: 'group-count', text: String(g.remarks.length) })),
        remarksTable(g.remarks))));
}

function remarksTable(remarks) {
  return el('table', { class: 'lines-table' },
    el('thead', {}, el('tr', {}, ...['EHDS element', 'Belgian element', 'Relationship', 'Remark'].map((h) => el('th', { class: 'no-sort', text: h })))),
    el('tbody', {}, ...remarks.map((r) => el('tr', {}, el('td', {}, el('code', { text: r.element })), el('td', {}, r.target ? el('code', { text: r.target }) : '—'), el('td', { text: r.relationship ?? '' }), el('td', { class: 'remark', text: r.remark })))));
}

async function openMapping(modelKey, conceptMapId) {
  const c = state.compareByKey.get(modelKey);
  const g = c?.mappings.find((x) => x.conceptMap.id === conceptMapId);
  if (!g) return;
  history.replaceState(null, '', `#mapping/${encodeURIComponent(modelKey)}/${encodeURIComponent(conceptMapId)}`);
  const src = state.byKey.get(c.key);
  const tgt = g.targetKey ? state.byKey.get(g.targetKey) : null;
  document.getElementById('drawer').hidden = false;
  const figure = (entry, label) =>
    el('div', {}, el('h4', { text: `${label}: ${entry?.name ?? g.targetName}` }),
      entry && svgUrl(entry, 'modelgram') ? el('div', { class: 'drawer-figure' }, el('a', { href: `#model/${encodeURIComponent(entry.key)}` }, el('img', { src: svgUrl(entry, 'modelgram'), alt: entry.name }))) : el('p', { class: 'muted', text: 'not fetched' }));
  setChildren(
    document.getElementById('drawer-content'),
    el('h2', { text: `${c.id} → ${g.targetName}` }),
    el('p', { class: 'model-title', text: g.conceptMap.title }),
    g.changes.length ? el('div', { class: 'notice', text: `Made against an older model: ${changesText(g.changes)}` }) : null,
    el('div', { class: 'stats' },
      stat(`${pct(g.counts.mapped + g.counts.noMap, c.elementCount)}%`, 'decided'),
      stat(g.counts.mapped, 'mapped'), stat(g.counts.noMap, 'no equivalent'), stat(g.counts.open, 'open'), stat(g.remarks.length, 'remarks')),
    el('div', { class: 'side-by-side' }, figure(src, 'EHDS'), figure(tgt, 'Belgian')),
    el('h3', { class: 'section-head', text: 'Lines' }),
    linesTable(c, g),
    el('dl', { class: 'meta' }, ...[
      ['File', `mappings/${g.file}`],
      ['ConceptMap', g.conceptMap.url ?? g.conceptMap.id],
      ['Status', g.conceptMap.status ?? '—'],
      ['Date', fmtDate(g.conceptMap.date)],
      ['EHDS model', `${c.url}${g.sourceVersion ? ` | mapped against ${g.sourceVersion}` : ''} (now ${c.version ?? '—'}, ${fmtDay(c.date)})`],
      ['Belgian model', `${g.target}${g.targetVersion ? ` | mapped against ${g.targetVersion}` : ''}${tgt ? ` (now ${tgt.version ?? '—'}, ${fmtDay(tgt.date)})` : ''}`],
    ].flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
  );
}

function stat(v, l) {
  return el('div', { class: 'stat' }, el('div', { class: 'v', text: String(v) }), el('div', { class: 'l', text: l }));
}

function linesTable(c, g) {
  // every EHDS element, in model order, with its line (or "open")
  const byCode = new Map(g.lines.map((l) => [l.code, l]));
  const sd = SD_CACHE.get(c.key);
  const host = el('div', {}, el('p', { class: 'muted', text: 'Loading…' }));
  const entry = state.byKey.get(c.key);
  (sd ?? loadSd(entry)).then((def) => {
    const elements = (def.snapshot?.element ?? def.differential?.element ?? []).filter((e) => (e.id ?? e.path).includes('.'));
    const rows = elements.map((e) => {
      const id = e.id ?? e.path;
      const l = byCode.get(id) ?? byCode.get(e.path);
      const targets = l?.targets?.length ? l.targets : [null];
      return targets.map((t, i) =>
        el('tr', { class: `st-${l?.status ?? 'open'}` },
          el('td', {}, i === 0 ? el('code', { text: id }) : ''),
          el('td', {}, t?.code ? el('code', { text: t.code }) : l?.status === 'no-map' ? 'no equivalent' : '—'),
          el('td', { text: t?.relationship ?? '' }),
          el('td', { class: 'remark', text: t?.comment ?? '' })));
    });
    const extra = g.unknownElements.map((code) => el('tr', { class: 'st-open' }, el('td', {}, el('code', { text: code })), el('td', { colspan: 3, text: 'not in the EHDS model any more' })));
    setChildren(host, el('table', { class: 'lines-table' },
      el('thead', {}, el('tr', {}, ...['EHDS element', 'Belgian element', 'Relationship', 'Remark'].map((h) => el('th', { class: 'no-sort', text: h })))),
      el('tbody', {}, ...rows.flat(), ...extra)));
  });
  return host;
}

// ---------------------------------------------------------------- progress view

function renderProgress() {
  const host = document.getElementById('progress-body');
  const points = state.progress.points ?? [];
  if (!points.length) return setChildren(host, el('div', { class: 'empty' }, el('h3', { text: 'No progress data' })));
  const now = points[points.length - 1].logical;
  const decided = now.mapped + now.noMap;
  setChildren(
    host,
    el('div', { class: 'stats' },
      stat(`${pct(decided, now.elements)}%`, `of ${now.elements} EHDS elements decided`),
      stat(`${now.mappedModels} / ${now.models}`, 'EHDS models with a mapping'),
      stat(now.mapped, 'elements mapped'),
      stat(now.noMap, 'with no Belgian equivalent'),
      stat(now.remarks, 'remarks'),
      stat(state.comparison.summary.outdated ?? 0, 'mappings made against an older model')),
    progressChart(points),
    events(),
    el('p', { class: 'hint', text: 'One point per commit that changed mappings/ (date = commit date), compared with the current models. The versions each ConceptMap was made against are recorded per point; when they change it is listed as an event.' }),
  );
}

const SERIES = [
  { key: 'mapped', label: 'Mapped', color: 'var(--viz-mapped)' },
  { key: 'noMap', label: 'No equivalent', color: 'var(--viz-nomap)' },
];

function progressChart(points) {
  const scoped = (p) => {
    const L = p.logical;
    const total = ui.progressScope === 'mapped' ? L.mappedElements ?? L.elements : L.elements;
    return { ...L, total, open: Math.max(0, total - L.mapped - L.noMap) };
  };
  const scopeSelect = el('select', { onchange: (e) => { ui.progressScope = e.target.value; renderProgress(); } },
    el('option', { value: 'all', selected: ui.progressScope === 'all', text: 'All EHDS logical models' }),
    el('option', { value: 'mapped', selected: ui.progressScope === 'mapped', text: 'Only models with a mapping' }));
  const card = el('div', { class: 'chart-card' },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' } },
      el('div', {},
        el('h3', { text: 'EHDS logical model elements decided over time' }),
        el('div', { class: 'sub', text: 'Mapped to a Belgian element, or recorded as having no Belgian equivalent; the rest is open.' })),
      el('label', { class: 'field' }, el('span', { text: 'Out of' }), scopeSelect)),
    el('div', { class: 'chart-legend' },
      ...SERIES.map((s) => el('span', {}, el('i', { style: { background: s.color } }), s.label)),
      el('span', {}, el('i', { style: { background: 'var(--viz-open)' } }), 'Open')));

  const W = 860, H = 260, M = { t: 10, r: 130, b: 26, l: 44 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const t0 = Date.parse(points[0].date);
  // the axis runs to today, so the current state has width
  const t1 = Math.max(Date.parse(points[points.length - 1].date), Date.parse(state.catalog.generatedAt) || Date.now(), t0 + 86400000);
  const total = Math.max(...points.map((p) => scoped(p).total), 1);
  const x = (d) => M.l + ((Date.parse(d) - t0) / (t1 - t0)) * iw;
  const y = (v) => M.t + ih - (v / total) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Stacked step chart of mapped and no-equivalent elements over time' });

  for (let i = 0; i <= 4; i++) {
    const v = (total * i) / 4;
    svg.append(svgEl('line', { x1: M.l, x2: M.l + iw, y1: y(v), y2: y(v), stroke: 'var(--viz-grid)', 'stroke-width': 1 }));
    const t = svgEl('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = `${Math.round((100 * i) / 4)}%`;
    svg.append(t);
  }
  for (const tk of [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1]) {
    const t = svgEl('text', { x: x(new Date(tk).toISOString()), y: H - 6, 'text-anchor': 'middle' });
    t.textContent = new Date(tk).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    svg.append(t);
  }

  // step areas, each state held until the next point (the last one until today)
  const pts = [...points, { ...points[points.length - 1], date: new Date(t1).toISOString() }];
  const stepPath = (lo, hi) => {
    let top = '', bottom = '';
    pts.forEach((p, i) => {
      const xi = x(p.date);
      const xn = i < pts.length - 1 ? x(pts[i + 1].date) : xi;
      top += `${i ? 'L' : 'M'}${xi},${y(hi(scoped(p)))} L${xn},${y(hi(scoped(p)))} `;
      bottom = `L${xn},${y(lo(scoped(p)))} L${xi},${y(lo(scoped(p)))} ` + bottom;
    });
    return `${top}${bottom}Z`;
  };
  svg.append(svgEl('path', { d: stepPath(() => 0, (p) => p.total), fill: 'var(--viz-open)' }));
  svg.append(svgEl('path', { d: stepPath(() => 0, (p) => p.mapped), fill: SERIES[0].color }));
  // 2px surface gap between the stacked fills
  svg.append(svgEl('path', { d: stepPath((p) => p.mapped, (p) => p.mapped + p.noMap), fill: SERIES[1].color, stroke: 'var(--surface)', 'stroke-width': 2 }));

  // direct labels at the right end, pushed apart from the bottom up so they never overlap
  const last = scoped(points[points.length - 1]);
  const labels = [
    { text: `Mapped ${last.mapped}`, y: y(last.mapped / 2) + 4 },
    { text: `No equivalent ${last.noMap}`, y: y(last.mapped + last.noMap / 2) + 4 },
    { text: `Open ${last.open}`, y: y(last.mapped + last.noMap + last.open / 2) + 4 },
  ];
  let floor = M.t + ih + 4;
  for (const l of labels) {
    l.y = Math.min(l.y, floor);
    floor = l.y - 14;
    const t = svgEl('text', { x: M.l + iw + 8, y: l.y, class: 'dlabel' });
    t.textContent = l.text;
    svg.append(t);
  }

  for (const ev of state.progress.events ?? []) {
    const m = svgEl('circle', { cx: x(ev.date), cy: M.t + ih, r: 4, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.5 });
    const title = svgEl('title');
    title.textContent = `${fmtDay(ev.date)}: ${ev.text}`;
    m.append(title);
    svg.append(m);
  }

  const cross = svgEl('line', { y1: M.t, y2: M.t + ih, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0 });
  const hit = svgEl('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent' });
  svg.append(cross, hit);
  const tip = el('div', { class: 'tooltip', hidden: true });
  const chart = el('div', { class: 'chart' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let p = points[0];
    for (const q of points) if (x(q.date) <= px) p = q;
    const L = scoped(p);
    const cx = Math.max(x(p.date), M.l);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('opacity', 0.5);
    setChildren(tip,
      el('div', { class: 'tt-head', text: `${fmtDay(p.date)}${p.commit ? ` · ${p.commit.slice(0, 7)}` : ''}` }),
      el('div', { class: 'muted', text: p.subject }),
      ...[['Mapped', L.mapped, SERIES[0].color], ['No equivalent', L.noMap, SERIES[1].color], ['Open', L.open, 'var(--viz-open)']].map(([k, v, c]) =>
        el('div', { class: 'tt-row' }, el('span', {}, el('i', { style: { background: c } }), k), el('span', { text: `${v} (${pct(v, L.total)}%)` }))),
      el('div', { class: 'tt-row' }, el('span', { text: 'Models mapped' }), el('span', { text: `${L.mappedModels} / ${L.models}` })));
    tip.hidden = false;
    const cardBox = card.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - cardBox.left + 14, cardBox.width - 200)}px`;
    tip.style.top = `${e.clientY - cardBox.top + 10}px`;
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('opacity', 0);
  });

  card.append(chart, tip, tableView(points));
  return card;
}

function tableView(points) {
  return el('details', { class: 'table-view' }, el('summary', { text: 'Table view' }),
    el('table', {},
      el('thead', {}, el('tr', {}, ...['Date', 'Commit', 'Change', 'Models mapped', 'Mapped', 'No equivalent', 'Open', 'Remarks'].map((h) => el('th', { class: 'no-sort', text: h })))),
      el('tbody', {}, ...[...points].reverse().map((p) => el('tr', {},
        el('td', { text: fmtDate(p.date) }), el('td', {}, p.commit ? el('code', { text: p.commit.slice(0, 7) }) : '—'), el('td', { text: p.subject }),
        el('td', { class: 'num', text: `${p.logical.mappedModels} / ${p.logical.models}` }), el('td', { class: 'num', text: p.logical.mapped }),
        el('td', { class: 'num', text: p.logical.noMap }), el('td', { class: 'num', text: p.logical.open }), el('td', { class: 'num', text: p.logical.remarks }))))));
}

function events() {
  const evs = state.progress.events ?? [];
  if (!evs.length) return null;
  return el('div', { class: 'chart-card' }, el('h3', { text: 'Events' }), el('div', { class: 'sub', text: 'Mappings started, and changes of the model versions they were made against.' }),
    el('table', { class: 'lines-table' }, el('tbody', {}, ...[...evs].reverse().map((e) => el('tr', {}, el('td', { text: fmtDay(e.date) }), el('td', {}, e.commit ? el('code', { text: e.commit.slice(0, 7) }) : '—'), el('td', { text: e.text }))))));
}

// ---------------------------------------------------------------- profiles view

function renderProfiles() {
  const ehds = state.catalog.models.filter((m) => m.side === 'ehds' && m.kind === 'profile' && m.preferred);
  const be = state.catalog.models.filter((m) => m.side === 'be' && m.kind === 'profile' && m.preferred);
  const host = document.getElementById('profiles-body');
  if (!ehds.length) {
    return setChildren(host,
      el('div', { class: 'empty' },
        el('h3', { text: 'No EHDS profiles yet' }),
        el('p', { text: `The EHDS repository has only logical models for now. When it publishes profiles they are fetched with the models, listed here, and compared with the ${be.length} Belgian profiles through ConceptMaps in mappings/ - the same way as the logical models.` }),
        el('p', {}, el('button', { class: 'btn', text: `Browse the ${be.length} Belgian profiles`, onclick: () => {
          ui.kinds.clear(); ui.kinds.add('profile');
          ui.sides.clear(); ui.sides.add('be');
          drawChips();
          showView('models');
        } }))));
  }
  const p = state.comparison.profiles;
  setChildren(host,
    el('p', { class: 'hint', text: `${p.mapped} of ${p.models} EHDS profiles mapped to Belgian profiles · ${p.remarks} remarks` }),
    mappingTable(mappingRows('profile')),
    remarksSection(mappingRows('profile')));
}

boot().catch((err) => toast(err.message, 'err'));
