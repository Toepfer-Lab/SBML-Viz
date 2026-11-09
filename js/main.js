import { parseSBML, modelFromGraphJSON, parseFluxCSV, matchFlux, modelKey } from './model.js';
import { FLUX_EPS, fluxDomain, inFluxRange, buildIndex, buildGraph, compartmentStyles, detectSide, speciesSummary, sideKeyOf, findPath } from './graph.js';
import { createView3D } from './view.js';
import { createView2D } from './view2d.js';
import { fluxScale } from './style.js';
import * as ui from './ui.js';

const $ = id => document.getElementById(id);

const state = {
  model: null,
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

// Node positions per view mode, so 2D and 3D keep separate layouts.
const layouts = { 2: {}, 3: {} };

let view = null;
const VIEW_OPTIONS = ['drag', 'cluster', 'grid', 'labels', 'particles', 'rotate', 'quality'];

function mountView(dims) {
  view?.destroy();
  const create = dims === 2 ? createView2D : createView3D;
  view = create($('graph'), {
    onNodeClick: n => select(n.id),
    onFrozen: () => {
      Object.assign(layouts[state.dims], view.positions());
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

function loadModel(model, flux, fileName) {
  state.model = model;
  state.index = buildIndex(model);
  state.flux = flux || new Map();
  resetFluxFilter();
  state.styles = compartmentStyles(model);
  state.fileName = fileName;
  state.side = new Set(detectSide(state.index));
  state.hiddenCompartments = new Set([...state.styles.values()].filter(c => c.label === 'Boundary').map(c => c.id));
  state.scope = 'whole';
  state.focus = state.selected = state.path = null;
  state.showCut = false;
  state.live = true;
  layouts[2] = {};
  layouts[3] = {};

  $('import').hidden = true;
  $('app').hidden = false;
  $('model-chip').hidden = false;
  $('model-actions').hidden = false;
  mountView(state.dims);
  rebuild();
  setTimeout(() => view.fit(), 1500);
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
  const { flux, unmatched } = matchFlux(state.model, rows);
  if (!flux.size) {
    toast(`No rows in ${name} matched a reaction in the model. Check that IDs use the same prefix (e.g. with or without R_).`, true);
    return;
  }
  state.flux = flux;
  resetFluxFilter();
  rebuild();
  renderAll();
  const notes = [];
  if (unmatched.length) notes.push(`${unmatched.length} rows matched no reaction (e.g. ${unmatched.slice(0, 3).join(', ')})`);
  if (bad) notes.push(`${bad} rows had no numeric flux`);
  toast(`Loaded flux for ${flux.size} reactions.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`, !!unmatched.length);
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
    loadModel(model, new Map(), name);
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
  if (view) Object.assign(layouts[state.dims], view.positions());
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
  const own = layouts[state.dims];
  const hasOwn = graph.nodes.some(n => own[n.id]);
  for (const n of graph.nodes) {
    const p = own[n.id];
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
  if (!on) Object.assign(layouts[state.dims], view.positions());
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

function layoutKey() {
  return 'sbml-viz:layout:' + modelKey(state.model);
}

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(layoutKey()));
  } catch {
    return null;
  }
}

function saveLayout() {
  Object.assign(layouts[state.dims], view.positions());
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

let toastTimer = 0;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 4000);
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
  Object.assign(layouts[state.dims], view.positions());
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
      select(t.dataset.select, { fly: true, refocus: t.closest('#results') !== null });
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
  const focus = params.get('focus');
  if (focus && (state.model.species.has(focus) || state.model.reactions.has(focus))) {
    select(focus);
    openNeighbourhood();
  }
  if (params.get('from') && params.get('to')) {
    $('path-from').value = params.get('from');
    $('path-to').value = params.get('to');
    runPath();
  }
}

wire();
loadFromUrl();
