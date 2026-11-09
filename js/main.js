import { parseSBML, modelFromGraphJSON, parseFluxCSV, matchFlux, modelKey, findEncodings, findFluxEncodings, decodeModelIds } from './model.js';
import { FLUX_EPS, fluxDomain, inFluxRange, buildIndex, buildGraph, compartmentStyles, detectSide, speciesSummary, sideKeyOf, findPath } from './graph.js';
import { createView3D } from './view.js';
import { createView2D } from './view2d.js';
import { fluxScale, escapeHtml } from './style.js';
import * as ui from './ui.js';

const $ = id => document.getElementById(id);

const state = {
  model: null,             // as shown: ids decoded where an encoding was found
  rawModel: null,          // as parsed from the file
  ids: new Map(),          // SBML id -> shown id, for ids that differ
  sbmlIds: new Map(),      // shown id -> SBML id
  decodeCobra: readPref('decodeCobra', true),
  decodeLegacy: readPref('decodeLegacy', true),
  decoding: null,          // { found, entries } from decodeModelIds, for the ID decoding tab
  fluxRows: null,          // the flux table as read, matched again whenever ids change
  fluxMatch: null,         // matchFlux entries
  tab: 'graph',            // 'graph' | 'decoding'
  decodeList: 'model',     // ID decoding table: 'model' | 'flux'
  decodeFilter: 'all',     // 'all' | 'changed' | 'problems'
  index: null,
  flux: new Map(),
  styles: new Map(),
  fileName: '',
  side: new Set(),
  hiddenCompartments: new Set(),
  scope: 'whole',          // 'whole' | 'hood' | 'path'
  focus: null,
  selected: null,
  hops: 2,
  showCut: false,
  path: null,              // { ids, undirected } from findPath
  sideMode: 'dup',
  fluxMin: null,           // |v| range shown; null = open end
  fluxMax: null,
  showZero: false,
  fluxScaleMode: 'model',  // colour scale over the 'model' or the 'visible' flux
  fluxDomain: null,        // [min, max] non-zero |v| in the model
  colorRange: null,        // [min, max] the colour scale spans, for the legend
  labels: 'focus',
  particles: 'focus',
  quality: 'auto',
  dims: 3,
  live: true,              // forces running; freezes once the layout settles
  drag: true,
  cluster: true,
  grid: true,
  rotate: false,
  settingsOpen: false,
  reactionsShown: 0,
  hiddenByFlux: 0,
};

// Node positions per view mode, so 2D and 3D keep separate layouts. Keyed by
// SBML id (see layoutId), so they survive a change of ID decoding.
const layouts = { 2: {}, 3: {} };
let layoutIds = new Map(); // node id in the drawn graph -> its key in `layouts`

let view = null;
const VIEW_OPTIONS = ['drag', 'cluster', 'grid', 'labels', 'particles', 'rotate', 'quality'];

function mountView(dims) {
  view?.destroy();
  const create = dims === 2 ? createView2D : createView3D;
  view = create($('graph'), {
    onNodeClick: n => select(n.id),
    onFrozen: () => {
      storePositions();
      if (state.live) {
        state.live = false;
        renderLayoutToggle();
      }
    },
    options: Object.fromEntries(VIEW_OPTIONS.map(k => [k, state[k]])),
  });
}

let frames = 0;
let lastFps = performance.now();
(function countFrames() {
  frames++;
  const now = performance.now();
  if (now - lastFps >= 500) {
    if (view) {
      const quality = view.qualityText();
      $('stats').textContent = `${Math.round((frames * 1000) / (now - lastFps))} fps${quality ? ' · ' + quality : ''}`;
    }
    frames = 0;
    lastFps = now;
  }
  requestAnimationFrame(countFrames);
})();

// --- loading ------------------------------------------------------------------

// `fluxRows` ([id, v] pairs, or null) is matched against the ids as shown.
// `quiet` skips the decoding note. `keep` ({ selected, focus, scope } with SBML
// ids) re-shows the same file with a decoding setting changed: layouts,
// hidden compartments, side metabolites and the selection carry over.
function loadModel(raw, fluxRows, fileName, { quiet = false, keep = null } = {}) {
  state.rawModel = raw;
  const found = findEncodings(raw);
  const { model, entries } = decodeModelIds(raw, {
    cobra: state.decodeCobra && found.cobra > 0,
    legacy: state.decodeLegacy && found.legacy > 0,
  });
  state.decoding = { found, entries };
  state.ids = new Map(entries.filter(e => e.kind !== 'gene' && e.raw !== e.shown).map(e => [e.raw, e.shown]));
  state.sbmlIds = new Map([...state.ids].map(([id, shown]) => [shown, id]));
  state.model = model;
  state.index = buildIndex(model);
  const matched = fluxRows ? matchFlux(model, fluxRows, sbmlId) : null;
  state.fluxRows = fluxRows;
  state.fluxMatch = matched?.entries || null;
  state.flux = matched?.flux || new Map();
  if (state.decodeList === 'flux' && !state.fluxMatch) state.decodeList = 'model';
  resetFluxFilter();
  state.styles = compartmentStyles(model);
  state.fileName = fileName;
  if (!keep) {
    state.side = new Set(detectSide(state.index));
    state.hiddenCompartments = new Set([...state.styles.values()].filter(c => c.label === 'Boundary').map(c => c.id));
    layouts[2] = {};
    layouts[3] = {};
  }
  const kept = id => (id && (model.species.has(shownId(id)) || model.reactions.has(shownId(id))) ? shownId(id) : null);
  state.focus = kept(keep?.focus);
  state.selected = kept(keep?.selected);
  state.scope = keep?.scope === 'hood' && state.focus ? 'hood' : 'whole';
  state.path = null;
  state.showCut = false;
  state.live = !Object.keys(layouts[state.dims]).length;

  $('import').hidden = true;
  $('app').hidden = false;
  $('model-chip').hidden = false;
  $('model-actions').hidden = false;
  $('tabs').hidden = false;
  mountView(state.dims);
  rebuild();
  setTimeout(() => view.fit(), 1500);
  const renamed = entries.filter(e => e.raw !== e.shown).length;
  if (renamed && !quiet) {
    const layers = [...new Set(entries.flatMap(e => e.applied))];
    const clashes = entries.filter(e => e.clash).length;
    const what = layers.length > 1 ? 'cobrapy and COBRA Toolbox encodings' : `${layers[0]}-specific encoding`;
    toast(`${what} detected: ${renamed} IDs shown in readable form${clashes ? `; ${clashes} not fully decoded, as that would make two IDs equal` : ''}.`,
      false, 10000, { label: 'Review', run: () => showTab('decoding', 'model') });
  }
  $('species-options').innerHTML = [...model.species.keys()].sort()
    .map(id => `<option value="${id.replace(/"/g, '&quot;')}">`).join('');
  ui.renderPathResult($('path-result'), null);
  renderAll();
  $('btn-restore').disabled = !readLayout();
}

function loadFlux(text, name) {
  if (!state.model) {
    showStatus('error', 'Load a model first', 'A flux table needs an SBML model to attach to.');
    return;
  }
  const { rows, bad } = parseFluxCSV(text);
  const { flux, entries, unmatched } = matchFlux(state.model, rows, sbmlId);
  if (!flux.size) {
    toast(`No rows in ${name} matched a reaction in the model, even with cobrapy and COBRA Toolbox encodings decoded.`, true);
    return;
  }
  state.fluxRows = rows;
  state.fluxMatch = entries;
  state.flux = flux;
  resetFluxFilter();
  rebuild();
  renderAll();
  const decoded = entries.filter(e => e.how === 'decoded').length;
  const ambiguous = entries.filter(e => e.status === 'ambiguous').length;
  const notes = [];
  if (decoded) notes.push(`${decoded} matched after decoding their IDs`);
  if (ambiguous) notes.push(`${ambiguous} skipped because they fit more than one reaction`);
  if (unmatched.length > ambiguous) notes.push(`${unmatched.length - ambiguous} matched no reaction (e.g. ${entries.filter(e => e.status === 'unmatched').slice(0, 3).map(e => e.id).join(', ')})`);
  if (bad) notes.push(`${bad} rows had no numeric flux`);
  toast(`Loaded flux for ${flux.size} reactions.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`, unmatched.length > 0,
    undefined, decoded || unmatched.length ? { label: 'Review', run: () => showTab('decoding', 'flux') } : null);
}

function showProgress(label, fraction) {
  const el = $('progress');
  if (label === null) {
    el.hidden = true;
    return;
  }
  const pct = Math.round(fraction * 100);
  el.hidden = false;
  el.setAttribute('aria-valuenow', String(pct));
  $('progress-fill').style.width = `${pct}%`;
  $('progress-text').textContent = `${label} · ${pct}%`;
}

// Parse SBML in a worker so the page stays responsive. Falls back to the main
// thread where module workers are unavailable (e.g. pages opened via file://).
function parseInWorker(source, name) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(parseOnMainThread(source, name));
      return;
    }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') showProgress(`${data.stage} ${name}`, data.fraction);
      else {
        worker.terminate();
        if (data.type === 'done') resolve(data.model);
        else reject(new Error(data.message));
      }
    };
    worker.onerror = e => {
      e.preventDefault();
      worker.terminate();
      resolve(parseOnMainThread(source, name));
    };
    worker.postMessage(source);
  });
}

async function parseOnMainThread(source, name) {
  showProgress(`Reading ${name}`, 0);
  const text = source.file ? await source.file.text() : await (await fetch(source.url)).text();
  showProgress(`Parsing ${name}`, 0.5);
  await new Promise(r => setTimeout(r, 30)); // let the progress paint
  return parseSBML(text);
}

async function loadSBML(source, name) {
  try {
    const model = await parseInWorker(source, name);
    showProgress('Building graph', 1);
    await new Promise(r => setTimeout(r, 30));
    loadModel(model, null, name);
    return true;
  } catch (err) {
    showStatus('error', `Could not read ${name}`, err.message);
    if (state.model) toast(`Could not read ${name}: ${err.message}`, true);
    return false;
  } finally {
    showProgress(null);
  }
}

async function readFile(file) {
  if (/\.(csv|tsv|txt)$/i.test(file.name)) {
    loadFlux(await file.text(), file.name);
    return true;
  }
  return loadSBML({ file }, file.name);
}

async function loadExample() {
  try {
    const res = await fetch('data/example-model.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { model, flux } = modelFromGraphJSON(await res.json());
    loadModel(model, flux, 'bundled example');
  } catch (err) {
    showStatus('error', 'Could not load the example', `${err.message}. Serve the folder over HTTP (e.g. python3 -m http.server) instead of opening index.html directly.`);
  }
}

// --- graph ----------------------------------------------------------------------

function rebuild() {
  // Remember where everything is before the graph changes.
  if (view) storePositions();
  const graph = buildGraph(state.model, state.index, state.flux, {
    scope: state.scope,
    focus: state.focus,
    hops: state.hops,
    sideMode: state.sideMode,
    side: state.side,
    fluxRange: fluxRange(),
    hiddenCompartments: state.hiddenCompartments,
    showCut: state.showCut,
    path: state.path?.ids || null,
  });
  state.reactionsShown = graph.reactionsShown;
  state.hiddenByFlux = graph.hiddenByFlux;
  if (state.selected && !graph.nodes.some(n => n.id === state.selected)) state.selected = null;

  // 2D and 3D are independent: each mode seeds only from its own layout, and
  // a mode never laid out generates one with its own forces.
  layoutIds = new Map(graph.nodes.map(n => [n.id, layoutId(n)]));
  const own = layouts[state.dims];
  const hasOwn = graph.nodes.some(n => own[layoutIds.get(n.id)]);
  for (const n of graph.nodes) {
    const p = own[layoutIds.get(n.id)];
    if (!p) continue;
    n.x = p[0];
    n.y = p[1];
    if (state.dims === 3) n.z = p[2];
  }
  if (!hasOwn) state.live = true;

  const fluxT = fluxScale(graph.links, state.fluxScaleMode === 'model' ? state.fluxDomain : null);
  state.colorRange = fluxT.range;
  view.setData(graph, { styles: state.styles, live: state.live, fluxT });
  view.setSelection(state.selected);
  view.setHighlight(state.scope === 'path' && state.path ? state.path.ids : null);
  renderLayoutToggle();
}

function select(id, { fly = false, refocus = false } = {}) {
  state.selected = id;
  if (id && refocus && state.scope === 'hood') {
    state.focus = id;
    state.showCut = false;
    rebuild();
  }
  view.setSelection(id);
  if (fly && id) setTimeout(() => view.flyTo(id), refocus ? 600 : 0);
  renderInspector();
  renderScope();
}

function setLive(on) {
  state.live = on;
  view.setLive(on);
  if (!on) storePositions();
  renderLayoutToggle();
}

// --- path ---------------------------------------------------------------------------

function runPath() {
  const from = $('path-from').value.trim();
  const to = $('path-to').value.trim();
  const m = state.model;
  let error = null;
  if (!m.species.has(from)) error = `No species "${from || '…'}" to start from.`;
  else if (!m.species.has(to)) error = `No species "${to || '…'}" to go to.`;
  else if (from === to) error = 'Start and end are the same species.';
  const result = error ? null : findPath(m, state.index, state.flux, from, to, {
    side: state.side,
    hiddenCompartments: state.hiddenCompartments,
    weighted: $('path-weighted').checked,
    threshold: Math.max(state.fluxMin || 0, FLUX_EPS),
  });
  if (!error && !result) error = `No route from ${from} to ${to}, even ignoring reaction directions. Side metabolites and hidden compartments are skipped.`;
  if (error) {
    ui.renderPathResult($('path-result'), { error }, m, state.flux);
    return;
  }
  state.path = result;
  state.scope = 'path';
  state.selected = from;
  rebuild();
  setTimeout(() => view.fit(), 900);
  ui.renderPathResult($('path-result'), result, m, state.flux);
  renderAll();
}

function clearPath() {
  state.path = null;
  ui.renderPathResult($('path-result'), null);
  if (state.scope === 'path') {
    state.scope = 'whole';
    rebuild();
    setTimeout(() => view.fit(), 800);
  }
  renderAll();
}

// --- rendering --------------------------------------------------------------------

function renderAll() {
  const m = state.model;
  document.body.classList.toggle('has-flux', state.flux.size > 0);
  document.body.classList.toggle('is-2d', state.dims === 2);
  $('chip-name').textContent = state.fileName || m.id;
  $('chip-stats').textContent = `· ${m.species.size} species · ${m.reactions.size} reactions`;
  $('chip-flux').textContent = state.flux.size ? '· flux loaded' : '';
  $('legend-side').hidden = state.sideMode !== 'dup';

  for (const seg of document.querySelectorAll('.seg[data-key]')) {
    const key = seg.dataset.key;
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(String(state[key]) === b.dataset.value));
    }
  }
  for (const sw of document.querySelectorAll('.switch[data-key]')) {
    sw.setAttribute('aria-checked', String(!!state[sw.dataset.key]));
  }
  const rotate = $('rotate');
  rotate.setAttribute('aria-pressed', String(state.rotate));
  rotate.setAttribute('aria-label', state.rotate ? 'Stop auto-rotate' : 'Start auto-rotate');

  const counts = new Map();
  for (const sp of m.species.values()) counts.set(sp.compartment, (counts.get(sp.compartment) || 0) + 1);
  ui.renderCompartments($('compartments'), state.styles, state.hiddenCompartments, counts);
  ui.renderSideList($('side-list'), [...state.side]);
  $('side-options').innerHTML = [...state.index.bases.keys()].filter(k => !state.side.has(k)).sort()
    .map(k => `<option value="${k.replace(/"/g, '&quot;')}">`).join('');
  renderFluxFilter();
  $('decode-note').textContent = decodeSummary();
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  $('decoding').hidden = state.tab !== 'decoding';
  if (state.tab === 'decoding') renderDecoding();
  const [lo, hi] = state.colorRange || [];
  $('legend-min').textContent = lo === undefined ? '' : ui.formatFlux(lo);
  $('legend-max').textContent = hi === undefined ? '' : ui.formatFlux(hi);

  $('settings').hidden = !state.settingsOpen;
  $('btn-settings').setAttribute('aria-expanded', String(state.settingsOpen));
  renderLayoutToggle();
  renderScope();
  renderInspector();
}

function renderLayoutToggle() {
  const b = $('layout-toggle');
  b.setAttribute('aria-pressed', String(state.live));
  $('layout-text').textContent = state.live ? 'Forces running · Freeze' : 'Layout frozen · Run forces';
  b.title = state.live
    ? 'Stop the simulation now and pin every node'
    : 'Run the force simulation again; it freezes once the layout settles';
}

function renderScope() {
  const hops = `${state.hops} ${state.hops === 1 ? 'hop' : 'hops'}`;
  $('hops-label').textContent = hops;
  const target = state.focus || state.selected;
  const dim = state.dims === 3 ? '3D' : '2D';
  const toggle = $('scope-toggle');
  const cut = $('cut-toggle');
  cut.hidden = true;
  if (state.scope === 'path' && state.path) {
    const ids = state.path.ids;
    const n = ids.filter(id => state.model.reactions.has(id)).length;
    $('scope-text').textContent = `Path ${ids[0]} → ${ids[ids.length - 1]} · ${n} reactions · ${dim}`;
    toggle.textContent = 'Show whole model';
    toggle.disabled = false;
  } else if (state.scope === 'hood' && state.focus) {
    $('scope-text').textContent = `Neighbourhood of ${state.focus} · ${hops} · ${dim}`;
    toggle.textContent = 'Show whole model';
    toggle.disabled = false;
    if (state.hiddenByFlux || state.showCut) {
      cut.hidden = false;
      cut.textContent = state.showCut ? 'Hide reactions outside the |v| range' : `Show ${state.hiddenByFlux} outside the |v| range`;
    }
  } else {
    $('scope-text').textContent = `Whole model · ${dim} overview`;
    toggle.textContent = !target ? 'Select a node for its neighbourhood'
      : state.dims === 3 ? `Open ${target} neighbourhood in 2D` : `Open ${target} neighbourhood`;
    toggle.disabled = !target;
  }
  document.querySelector('.seg[data-key="scope"] button[data-value="hood"]').disabled = !target;
  for (const b of document.querySelectorAll('.seg[data-key="scope"] button')) {
    b.setAttribute('aria-pressed', String(state.scope === b.dataset.value));
  }
}

function renderInspector() {
  const el = $('inspector');
  const m = state.model;
  if (!state.selected) {
    ui.renderEmpty(el, m, state.flux);
    return;
  }
  const ctx = { styles: state.styles, flux: state.flux, scope: state.scope, canExpand: state.hops < 6 };
  const id = state.selected.includes('@') && !m.species.has(state.selected) && !m.reactions.has(state.selected)
    ? state.selected.split('@')[0]
    : state.selected;
  if (m.reactions.has(id)) {
    ui.renderReaction(el, m.reactions.get(id), ctx);
  } else if (m.species.has(id)) {
    ctx.isSide = state.side.has(sideKeyOf(m, id));
    ui.renderSpecies(el, speciesSummary(m, state.index, state.flux, id), ctx);
  }
}

// --- search -----------------------------------------------------------------------

function search(q) {
  const el = $('results');
  q = q.trim().toLowerCase();
  if (!q || !state.model) {
    el.innerHTML = '';
    return;
  }
  const hits = [];
  const consider = (item, kind) => {
    const id = item.id.toLowerCase();
    const name = item.name.toLowerCase();
    const rank = id === q ? 0 : id.startsWith(q) ? 1 : id.includes(q) ? 2 : name.includes(q) ? 3 : -1;
    if (rank >= 0) hits.push({ ...item, kind, rank });
  };
  for (const sp of state.model.species.values()) consider(sp, 'met');
  for (const r of state.model.reactions.values()) consider(r, 'rxn');
  hits.sort((a, b) => a.rank - b.rank || a.id.length - b.id.length || a.id.localeCompare(b.id));
  ui.renderResults(el, hits.slice(0, 50), state.styles);
}

// --- layouts, export, messages --------------------------------------------------------

// Keyed by the file as parsed, so a saved layout is found whatever is decoded.
function layoutKey() {
  return 'sbml-viz:layout:' + modelKey(state.rawModel);
}

// A side metabolite copy (species@reaction) is keyed by both SBML ids.
function layoutId(n) {
  return n.kind === 'side' ? `${sbmlId(n.ref)}@${sbmlId(n.reaction)}` : sbmlId(n.id);
}

function storePositions() {
  for (const [id, p] of Object.entries(view.positions())) layouts[state.dims][layoutIds.get(id) ?? id] = p;
}

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(layoutKey()));
  } catch {
    return null;
  }
}

function saveLayout() {
  storePositions();
  try {
    localStorage.setItem(layoutKey(), JSON.stringify({ v: 2, 2: layouts[2], 3: layouts[3] }));
    $('btn-restore').disabled = false;
    toast('2D and 3D layouts saved in this browser.');
  } catch (err) {
    toast(`Could not save the layout: ${err.message}`, true);
  }
}

function restoreLayout() {
  const saved = readLayout();
  if (!saved) return;
  // v1 stored one flat positions object for whichever mode was active.
  const both = saved.v === 2 ? saved : { 2: saved, 3: saved };
  layouts[2] = { ...both[2] };
  layouts[3] = { ...both[3] };
  state.live = false;
  // A fresh view, so rebuild() does not fold the current positions back in.
  mountView(state.dims);
  rebuild();
  setTimeout(() => view.fit(), 300);
  renderAll();
  toast('Restored the saved layout. It stays frozen until you run forces.');
}

function exportPng() {
  const a = document.createElement('a');
  a.href = view.screenshot();
  a.download = `${state.model.id}.png`;
  a.click();
}

// Messages stack while earlier ones are still showing; each leaves on its own time.
function toast(text, isError = false, ms = isError ? 8000 : 4000, action = null) {
  const el = document.createElement('div');
  el.className = isError ? 'toast error' : 'toast';
  el.append(text);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.remove(); action.run(); });
    el.append(b);
  }
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function showStatus(kind, title, body) {
  const icon = kind === 'error'
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F28B82" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>'
    : '';
  const box = document.createElement('div');
  box.className = `notice ${kind}`;
  box.innerHTML = `${icon}<div class="stack-4"><span class="strong"></span><span class="notice-body"></span></div>`;
  box.querySelector('.strong').textContent = title;
  box.querySelector('.notice-body').textContent = body;
  $('import-status').replaceChildren(box);
}

// --- wiring -----------------------------------------------------------------------------

function setOption(key, raw) {
  const value = key === 'dims' ? Number(raw) : raw;
  if (key === 'scope') {
    if (value === 'hood') {
      state.focus = state.selected || state.focus;
      state.showCut = false;
    }
    state.scope = value === 'hood' && !state.focus ? 'whole' : value;
    rebuild();
    setTimeout(() => view.fit(), 800);
  } else if (key === 'dims') {
    // switchDims files the outgoing view's positions under state.dims, so it
    // must still name the old mode when it runs.
    if (value !== state.dims) switchDims(value);
  } else {
    state[key] = value;
    if (key === 'sideMode' || key === 'fluxScaleMode') rebuild();
    else view.set(key, value);
  }
  renderAll();
}

function switchDims(dims) {
  storePositions();
  state.dims = dims;
  if (dims === 2) state.rotate = false;
  // A mode with a saved layout opens frozen, exactly as it was left.
  state.live = !Object.keys(layouts[dims]).length;
  mountView(dims);
  rebuild();
  setTimeout(() => view.fit(), state.live ? 1200 : 100);
}

// The 3D overview's call to action: drill into the selection as a 2D map.
function openNeighbourhood() {
  state.focus = state.selected || state.focus;
  if (!state.focus) return;
  state.scope = 'hood';
  state.showCut = false;
  if (state.dims === 3) {
    switchDims(2);
  } else {
    rebuild();
    setTimeout(() => view.fit(), 800);
  }
  renderAll();
}

function wire() {
  $('sbml-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const ok = await readFile(f);
    // A flux file picked before the model is applied once the model loads.
    const fluxFile = $('flux-input').files[0];
    if (ok !== false && fluxFile && state.model) loadFlux(await fluxFile.text(), fluxFile.name);
    e.target.value = '';
  });
  $('flux-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f && !state.model) showStatus('', `${f.name} selected`, 'It will be applied once you load a model.');
  });
  $('flux-input-top').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) loadFlux(await f.text(), f.name);
    e.target.value = '';
  });
  $('btn-example').addEventListener('click', loadExample);
  $('btn-open').addEventListener('click', () => $('sbml-input').click());
  $('btn-save').addEventListener('click', saveLayout);
  $('btn-restore').addEventListener('click', restoreLayout);
  $('btn-export').addEventListener('click', exportPng);
  $('layout-toggle').addEventListener('click', () => setLive(!state.live));

  // Drag & drop anywhere. dragover must be cancelled or `drop` never fires.
  const overlay = $('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); depth++; overlay.hidden = false; });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...e.dataTransfer.files];
    // Model first, so a model + flux dropped together both apply.
    files.sort((a, b) => /\.(csv|tsv|txt)$/i.test(a.name) - /\.(csv|tsv|txt)$/i.test(b.name));
    for (const f of files) await readFile(f);
  });

  const searchInput = $('search');
  searchInput.addEventListener('input', () => search(searchInput.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('results').querySelector('[data-select]')?.click();
  });

  $('path-form').addEventListener('submit', e => {
    e.preventDefault();
    runPath();
  });
  $('path-clear').addEventListener('click', clearPath);

  // Delegated clicks: selection links, segmented controls, switches, chips.
  document.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.select) {
      if (t.closest('#decoding')) showTab('graph');
      select(t.dataset.select, { fly: true, refocus: t.closest('#results') !== null });
      return;
    }
    if (t.dataset.tab) {
      showTab(t.dataset.tab);
      return;
    }
    if (t.dataset.decodeList || t.dataset.decodeFilter) {
      if (t.dataset.decodeList) state.decodeList = t.dataset.decodeList;
      if (t.dataset.decodeFilter) state.decodeFilter = t.dataset.decodeFilter;
      renderDecoding();
      return;
    }
    if (t.dataset.find !== undefined) {
      $('decode-search').value = t.dataset.find;
      renderDecoding();
      return;
    }
    if (t.dataset.pathFrom || t.dataset.pathTo) {
      if (t.dataset.pathFrom) $('path-from').value = t.dataset.pathFrom;
      if (t.dataset.pathTo) $('path-to').value = t.dataset.pathTo;
      if ($('path-from').value && $('path-to').value) runPath();
      else ($('path-from').value ? $('path-to') : $('path-from')).focus();
      return;
    }
    const seg = t.closest('.seg[data-key]');
    if (seg && t.dataset.value !== undefined) {
      setOption(seg.dataset.key, t.dataset.value);
      return;
    }
    if (t.classList.contains('switch')) {
      const key = t.dataset.key;
      state[key] = !state[key];
      if (key === 'decodeCobra' || key === 'decodeLegacy') {
        writePref(key, state[key]);
        reshowModel();
        return;
      }
      if (key === 'showZero') rebuild();
      else view.set(key, state[key]);
      renderAll();
      return;
    }
    if (t.dataset.compartment) {
      const c = t.dataset.compartment;
      if (state.hiddenCompartments.has(c)) state.hiddenCompartments.delete(c);
      else state.hiddenCompartments.add(c);
      rebuild();
      renderAll();
      return;
    }
    if (t.dataset.side) {
      state.side.delete(t.dataset.side);
      rebuild();
      renderAll();
      return;
    }
    switch (t.dataset.action) {
      case 'expand': state.hops = Math.min(6, state.hops + 1); rebuild(); renderAll(); break;
      case 'hood': openNeighbourhood(); break;
      case 'clear': select(null); break;
      case 'decoding': showTab('decoding'); break;
    }
  });

  $('side-add').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('side-add-input');
    const key = input.value.trim();
    if (!state.index.bases.has(key)) {
      toast(`No species with base ID "${key}".`, true);
      return;
    }
    state.side.add(key);
    input.value = '';
    rebuild();
    renderAll();
  });

  // Flux range: labels and count follow the drag; the graph rebuilds on release.
  for (const input of [$('flux-lo'), $('flux-hi')]) {
    input.addEventListener('input', () => {
      const lo = $('flux-lo');
      const hi = $('flux-hi');
      if (Number(lo.value) > Number(hi.value)) input.value = input === lo ? hi.value : lo.value;
      renderFluxFilter(sliderRange());
    });
    input.addEventListener('change', () => {
      const { min, max } = sliderRange();
      state.fluxMin = min;
      state.fluxMax = max;
      rebuild();
      renderAll();
    });
  }
  $('scale-open').addEventListener('click', showFluxSettings);
  $('decode-search').addEventListener('input', renderDecoding);

  $('hops-down').addEventListener('click', () => changeHops(-1));
  $('hops-up').addEventListener('click', () => changeHops(1));
  $('cut-toggle').addEventListener('click', () => {
    state.showCut = !state.showCut;
    rebuild();
    renderAll();
  });
  $('scope-toggle').addEventListener('click', () => {
    if (state.scope !== 'whole') setOption('scope', 'whole');
    else openNeighbourhood();
  });
  $('btn-settings').addEventListener('click', () => { state.settingsOpen = !state.settingsOpen; renderAll(); });
  $('settings-close').addEventListener('click', () => { state.settingsOpen = false; renderAll(); $('btn-settings').focus(); });
  $('zoom-in').addEventListener('click', () => view.zoom(0.7));
  $('zoom-out').addEventListener('click', () => view.zoom(1.4));
  $('fit').addEventListener('click', () => view.fit());
  $('rotate').addEventListener('click', () => {
    state.rotate = !state.rotate;
    view.set('rotate', state.rotate);
    renderAll();
  });
}

// --- ID decoding --------------------------------------------------------------------

const ROW_LIMIT = 300;

function shownId(id) {
  return state.ids.get(id) ?? id;
}

function sbmlId(id) {
  return state.sbmlIds.get(id) ?? id;
}

// Show the same file again with a decoding setting changed; the flux table is
// matched again, and the layout and selection carry over by SBML id.
function reshowModel() {
  if (!state.rawModel) return;
  storePositions();
  loadModel(state.rawModel, state.fluxRows, state.fileName, {
    quiet: true,
    keep: { selected: sbmlId(state.selected), focus: sbmlId(state.focus), scope: state.scope },
  });
}

function showTab(tab, list) {
  state.tab = tab;
  if (list && (list === 'model' || state.fluxMatch)) state.decodeList = list;
  renderAll();
}

function decodeSummary() {
  const entries = state.decoding?.entries || [];
  const renamed = entries.filter(e => e.raw !== e.shown).length;
  const clashes = entries.filter(e => e.clash).length;
  const parts = [renamed ? `${renamed} IDs shown decoded` : 'IDs shown as written in the file'];
  if (clashes) parts.push(`${clashes} not fully decoded (clash)`);
  if (state.fluxMatch) {
    const m = state.fluxMatch;
    const matched = m.filter(e => e.reaction).length;
    const decoded = m.filter(e => e.how === 'decoded').length;
    parts.push(`flux: ${matched} of ${m.length} rows matched${decoded ? `, ${decoded} after decoding` : ''}`);
  }
  return parts.join(' · ') + '.';
}

function encodingFound(el, model, flux) {
  el.classList.toggle('found', model + flux > 0);
  el.querySelector('span:last-child').textContent = model + flux
    ? `Found · model: ${model} IDs${state.fluxMatch ? ` · flux file: ${flux} rows` : ''}`
    : `Not found${state.fluxMatch ? ' in the model or the flux file' : ' in this model'}`;
}

function renderDecoding() {
  if (!state.decoding) return;
  const { found, entries } = state.decoding;
  const fluxFound = state.fluxMatch ? findFluxEncodings(state.fluxMatch.map(e => e.id)) : { cobra: 0, legacy: 0 };
  encodingFound($('enc-cobra-found'), found.cobra, fluxFound.cobra);
  encodingFound($('enc-legacy-found'), found.legacy, fluxFound.legacy);
  for (const sw of document.querySelectorAll('#decoding .switch[data-key]')) {
    sw.setAttribute('aria-checked', String(!!state[sw.dataset.key]));
  }

  const flux = state.decodeList === 'flux' && state.fluxMatch;
  const clashes = entries.filter(e => e.clash).length;
  const problems = flux
    ? state.fluxMatch.filter(e => !e.reaction).length
    : entries.filter(e => e.clash || e.clashedBy.length).length;
  $('decode-summary').innerHTML = escapeHtml(decodeSummary())
    + (clashes ? ` <span class="problem-text">⚠ ${clashes} ${clashes === 1 ? 'ID is' : 'IDs are'} not fully decoded, as that would make ${clashes === 1 ? 'it equal another ID' : 'them equal other IDs'}. See Problems.</span>` : '');
  for (const b of document.querySelectorAll('[data-decode-list]')) {
    b.setAttribute('aria-pressed', String(b.dataset.decodeList === (flux ? 'flux' : 'model')));
    b.disabled = b.dataset.decodeList === 'flux' && !state.fluxMatch;
  }
  for (const b of document.querySelectorAll('[data-decode-filter]')) {
    b.setAttribute('aria-pressed', String(b.dataset.decodeFilter === state.decodeFilter));
    if (b.dataset.decodeFilter === 'problems') b.textContent = `Problems (${problems})`;
  }

  const q = $('decode-search').value.trim().toLowerCase();
  const hit = (...xs) => !q || xs.some(x => x && x.toLowerCase().includes(q));
  let rows;
  if (flux) {
    rows = state.fluxMatch.filter(e => hit(e.id, e.reaction, sbmlId(e.reaction || ''), ...(e.candidates || []))
      && (state.decodeFilter === 'all'
        || (state.decodeFilter === 'changed' && e.reaction && e.how !== 'exact')
        || (state.decodeFilter === 'problems' && !e.reaction)));
    $('decode-head').innerHTML = '<tr><th>In the flux file</th><th>Reaction</th><th>Status</th></tr>';
  } else {
    const keep = e => hit(e.raw, e.shown, e.clash?.as)
      && (state.decodeFilter === 'all'
        || (state.decodeFilter === 'changed' && e.raw !== e.shown)
        || (state.decodeFilter === 'problems' && (e.clash || e.clashedBy.length)));
    // Ids that clashed are found and listed together, where the first of them is.
    const members = new Map();
    for (const e of entries) if (e.group) (members.get(e.group) || members.set(e.group, []).get(e.group)).push(e);
    rows = [];
    for (const e of entries) {
      if (!e.group) {
        if (keep(e)) rows.push(e);
      } else if (members.get(e.group)[0] === e && members.get(e.group).some(keep)) {
        rows.push(...members.get(e.group));
      }
    }
    $('decode-head').innerHTML = '<tr><th>Type</th><th>In the SBML file</th><th>Shown as</th><th>Status</th></tr>';
  }
  // Never cut a clash group in half at the row limit.
  let end = Math.min(rows.length, ROW_LIMIT);
  while (end < rows.length && rows[end].group && rows[end].group === rows[end - 1].group) end++;
  $('decode-body').innerHTML = rows.slice(0, end).map(flux ? ui.fluxMatchRow : ui.decodeRow).join('')
    || `<tr><td colspan="4" class="muted">No ${q ? 'matching ' : ''}rows.</td></tr>`;
  $('decode-more').textContent = rows.length > end
    ? `Showing ${end} of ${rows.length} rows. Search to narrow them down.`
    : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`;
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem('sbml-viz:pref:' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem('sbml-viz:pref:' + key, JSON.stringify(value));
  } catch { /* preference only */ }
}

// --- flux filter ---------------------------------------------------------------------
// The range slider runs 0..STEPS on a log scale over the model's non-zero |v|;
// a handle at either end leaves that side of the range open.

const STEPS = 1000;
let attentionTimer = 0;

function resetFluxFilter() {
  state.fluxDomain = fluxDomain(state.flux);
  state.fluxMin = state.fluxMax = null;
}

function fluxRange() {
  return { min: state.fluxMin, max: state.fluxMax, zero: state.showZero };
}

function toFlux(pos) {
  const [lo, hi] = state.fluxDomain;
  return lo * (hi / lo) ** (pos / STEPS);
}

function toPos(v) {
  const [lo, hi] = state.fluxDomain;
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(STEPS, Math.round((STEPS * Math.log(v / lo)) / Math.log(hi / lo))));
}

function sliderRange() {
  const lo = Number($('flux-lo').value);
  const hi = Number($('flux-hi').value);
  return { min: lo > 0 ? toFlux(lo) : null, max: hi < STEPS ? toFlux(hi) : null, zero: state.showZero };
}

// Without `preview` the handles are set from state; while dragging they lead.
function renderFluxFilter(preview = null) {
  const lo = $('flux-lo');
  const hi = $('flux-hi');
  const d = state.fluxDomain;
  lo.disabled = hi.disabled = !d || d[0] === d[1];
  if (!d) {
    $('flux-lo-text').textContent = $('flux-hi-text').textContent = '';
    $('flux-count').textContent = '0';
    return;
  }
  const range = preview || fluxRange();
  if (!preview) {
    lo.value = range.min === null ? 0 : toPos(range.min);
    hi.value = range.max === null ? STEPS : toPos(range.max);
  }
  const loText = ui.formatFlux(range.min ?? d[0]);
  const hiText = ui.formatFlux(range.max ?? d[1]);
  $('flux-lo-text').textContent = loText;
  $('flux-hi-text').textContent = hiText;
  lo.setAttribute('aria-valuetext', loText);
  hi.setAttribute('aria-valuetext', hiText);
  const box = $('flux-range');
  box.style.setProperty('--lo', `${(lo.value / STEPS) * 100}%`);
  box.style.setProperty('--hi', `${(hi.value / STEPS) * 100}%`);
  let n = 0;
  for (const id of state.model.reactions.keys()) if (inFluxRange(state.flux.get(id), range)) n++;
  $('flux-count').textContent = `${n} of ${state.model.reactions.size}`;
}

// The legend's colour bar opens the settings and points at the flux filter.
function showFluxSettings() {
  state.settingsOpen = true;
  renderAll();
  const section = $('flux-filter');
  section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  section.classList.remove('attention');
  void section.offsetWidth; // restart the animation on a repeated click
  section.classList.add('attention');
  clearTimeout(attentionTimer);
  attentionTimer = setTimeout(() => section.classList.remove('attention'), 2000);
  $('flux-lo').focus({ preventScroll: true });
}

function changeHops(delta) {
  state.hops = Math.max(1, Math.min(6, state.hops + delta));
  if (state.selected || state.focus) {
    state.focus = state.focus || state.selected;
    state.scope = 'hood';
    rebuild();
  }
  renderAll();
}

// Deep links: ?example loads the bundled model; ?model=<url>[&flux=<url>] loads
// files by URL; &focus=<id> opens that node's neighbourhood as a 2D map;
// &from=<id>&to=<id> finds a path; &vmin=<|v|>&vmax=<|v|> set the flux range.
async function loadFromUrl() {
  const params = new URLSearchParams(location.search);
  const modelUrl = params.get('model');
  if (params.has('example')) {
    await loadExample();
  } else if (modelUrl) {
    const ok = await loadSBML({ url: new URL(modelUrl, location.href).href }, modelUrl.split('/').pop());
    const fluxUrl = params.get('flux');
    if (ok && fluxUrl) loadFlux(await (await fetch(fluxUrl)).text(), fluxUrl.split('/').pop());
  }
  if (!state.model) return;
  const vmin = Number(params.get('vmin'));
  const vmax = Number(params.get('vmax'));
  if (state.flux.size && (vmin > 0 || vmax > 0)) {
    if (vmin > 0) state.fluxMin = vmin;
    if (vmax > 0) state.fluxMax = vmax;
    rebuild();
    renderAll();
  }
  const focus = params.get('focus') && shownId(params.get('focus'));
  if (focus && (state.model.species.has(focus) || state.model.reactions.has(focus))) {
    select(focus);
    openNeighbourhood();
  }
  if (params.get('from') && params.get('to')) {
    $('path-from').value = shownId(params.get('from'));
    $('path-to').value = shownId(params.get('to'));
    runPath();
  }
}

wire();
loadFromUrl();
