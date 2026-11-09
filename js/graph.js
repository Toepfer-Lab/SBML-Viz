// Pure graph building: model + flux + view options -> { nodes, links } for
// the force graph. No DOM or three.js here so it can be unit tested.

// |v| below this counts as zero flux (solver noise).
export const FLUX_EPS = 1e-9;

// Smallest and largest non-zero |v|: the range of the flux filter.
export function fluxDomain(flux) {
  let lo = Infinity;
  let hi = 0;
  for (const v of flux.values()) {
    const a = Math.abs(v);
    if (a < FLUX_EPS) continue;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  return hi ? [lo, hi] : null;
}

// range: { min, max, zero }. A null bound is open; `zero` keeps zero-flux reactions.
export function inFluxRange(v, { min = null, max = null, zero = false }) {
  const a = Math.abs(v || 0);
  if (a < FLUX_EPS) return zero;
  return (min === null || a >= min) && (max === null || a <= max);
}

// Known compartment ids -> label + color from the visual language.
const KNOWN = {
  p: ['Plastid', '#6CC08B'], h: ['Plastid', '#6CC08B'], chl: ['Plastid', '#6CC08B'],
  c: ['Cytosol', '#C9CED8'], cyt: ['Cytosol', '#C9CED8'],
  m: ['Mitochondrion', '#E8A35C'], mit: ['Mitochondrion', '#E8A35C'],
  x: ['Peroxisome', '#B48CE0'], per: ['Peroxisome', '#B48CE0'],
  v: ['Vacuole', '#5BA9E8'], vac: ['Vacuole', '#5BA9E8'],
  b: ['Boundary', '#8A919E'], e: ['Extracellular', '#8A919E'],
};
const FALLBACK = ['#D98AA6', '#7FC8C0', '#C7B26A', '#9AA5E8', '#D6A07E', '#8FBF6A'];

export function compartmentStyles(model) {
  const styles = new Map();
  let k = 0;
  for (const [id, name] of model.compartments) {
    const known = KNOWN[id] || KNOWN[String(name).toLowerCase()];
    const label = known ? known[0] : (name && name !== id ? name : id);
    styles.set(id, { id, label: label + (known && name !== id && name !== known[0] ? ` (${name})` : ''), color: known ? known[1] : FALLBACK[k++ % FALLBACK.length] });
  }
  return styles;
}

// Species that differ only by compartment share a base key: PROTON_c and
// PROTON_p -> PROTON. The compartment is matched as an id suffix, either by its
// full id or by its last part (compartment H_p, species H_PROTON_p), written
// as _p, [p] or [p] escaped by cobrapy or the COBRA Toolbox.
export function baseKey(sp) {
  const id = sp.id.replace(/^M_/, '');
  const c = sp.compartment || '';
  for (const code of new Set([c, c.slice(c.lastIndexOf('_') + 1)])) {
    if (!code) continue;
    for (const suffix of [`_${code}`, `[${code}]`, `__91__${code}__93__`, `_LSQBKT_${code}_RSQBKT_`]) {
      if (id.length > suffix.length && id.endsWith(suffix)) return id.slice(0, -suffix.length);
    }
  }
  return id;
}

export function buildIndex(model) {
  const speciesRxns = new Map();
  for (const id of model.species.keys()) speciesRxns.set(id, []);
  for (const r of model.reactions.values()) {
    for (const ref of [...r.reactants, ...r.products]) {
      if (!speciesRxns.has(ref.species)) speciesRxns.set(ref.species, []);
      const list = speciesRxns.get(ref.species);
      if (list[list.length - 1] !== r.id) list.push(r.id);
    }
  }
  const bases = new Map();
  for (const sp of model.species.values()) {
    const key = baseKey(sp);
    const b = bases.get(key) || { key, species: [], degree: 0 };
    b.species.push(sp.id);
    b.degree += speciesRxns.get(sp.id).length;
    bases.set(key, b);
  }
  return { speciesRxns, bases };
}

// Highly connected small molecules (water, protons, ATP...) turn the graph
// into a hairball; pick the top hubs by degree as the default side set.
export function detectSide(index, count = 12, minDegree = 10) {
  return [...index.bases.values()]
    .filter(b => b.degree >= minDegree)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, count)
    .map(b => b.key);
}

export function sideKeyOf(model, speciesId) {
  const sp = model.species.get(speciesId);
  return sp ? baseKey(sp) : speciesId;
}

/**
 * opts: {
 *   scope: 'whole' | 'hood', focus: node id | null, hops: number,
 *   sideMode: 'show' | 'dup' | 'hide', side: Set<baseKey>,
 *   fluxRange: { min, max, zero } | null, hiddenCompartments: Set<id>,
 *   showCut: boolean,   // neighbourhood: include reactions outside the flux range (drawn faint)
 *   path: [ids] | null, // scope 'path': species/reactions of a found path
 * }
 * Reactions outside the flux range that are drawn anyway (the focus's own
 * reactions, or all of them with showCut) carry `belowCut: true`.
 */
export function buildGraph(model, index, flux, opts) {
  const hasFlux = flux && flux.size > 0;
  const pathIds = opts.scope === 'path' && opts.path ? new Set(opts.path) : null;
  const isSide = id => opts.side.has(sideKeyOf(model, id)) && id !== opts.focus && !(pathIds && pathIds.has(id));
  const speciesVisible = id => {
    const sp = model.species.get(id);
    return sp && !opts.hiddenCompartments.has(sp.compartment);
  };
  const reactionVisible = id => {
    if (!hasFlux || !opts.fluxRange) return true;
    return inFluxRange(flux.get(id), opts.fluxRange);
  };

  // Which reactions (and, in neighbourhood scope, species) are in scope.
  let reactionIds;
  const cutByFlux = new Set();
  const faint = new Set();
  let speciesInScope = null;
  if (pathIds) {
    reactionIds = new Set(opts.path.filter(id => model.reactions.has(id)));
    speciesInScope = new Set(opts.path.filter(id => model.species.has(id)));
    for (const rid of reactionIds) {
      if (!reactionVisible(rid)) faint.add(rid);
      const r = model.reactions.get(rid);
      for (const ref of [...r.reactants, ...r.products]) {
        if (speciesVisible(ref.species)) speciesInScope.add(ref.species);
      }
    }
  } else if (opts.scope === 'hood' && opts.focus && (model.species.has(opts.focus) || model.reactions.has(opts.focus))) {
    reactionIds = new Set();
    speciesInScope = new Set();
    const startIsReaction = model.reactions.has(opts.focus);
    const maxDepth = 2 * Math.max(1, opts.hops) - (startIsReaction ? 1 : 0);
    let frontier = [opts.focus];
    const seen = new Set(frontier);
    if (startIsReaction) {
      reactionIds.add(opts.focus);
      if (!reactionVisible(opts.focus)) faint.add(opts.focus);
    } else {
      speciesInScope.add(opts.focus);
    }
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const id of frontier) {
        if (model.reactions.has(id)) {
          const r = model.reactions.get(id);
          for (const ref of [...r.reactants, ...r.products]) {
            if (seen.has(ref.species) || !speciesVisible(ref.species)) continue;
            seen.add(ref.species);
            speciesInScope.add(ref.species);
            // Side metabolites are drawn but never expanded through.
            if (!isSide(ref.species)) next.push(ref.species);
          }
        } else {
          for (const rid of index.speciesRxns.get(id) || []) {
            if (seen.has(rid)) continue;
            if (!reactionVisible(rid)) {
              // The focus's own reactions are always drawn, faint; the rest
              // only on request, and they are never expanded through.
              if (!opts.showCut && !(depth === 0 && id === opts.focus)) {
                cutByFlux.add(rid);
                continue;
              }
              faint.add(rid);
            }
            seen.add(rid);
            reactionIds.add(rid);
            if (!faint.has(rid) || opts.showCut) next.push(rid);
          }
        }
      }
      frontier = next;
    }
    // The outermost reactions still need their own species drawn.
    for (const rid of reactionIds) {
      const r = model.reactions.get(rid);
      for (const ref of [...r.reactants, ...r.products]) {
        if (speciesVisible(ref.species)) speciesInScope.add(ref.species);
      }
    }
  } else {
    reactionIds = new Set();
    for (const rid of model.reactions.keys()) {
      if (reactionVisible(rid)) reactionIds.add(rid);
      else if (opts.showCut) { reactionIds.add(rid); faint.add(rid); }
      else cutByFlux.add(rid);
    }
  }
  for (const rid of reactionIds) cutByFlux.delete(rid);

  const nodes = new Map();
  const links = [];
  const addSpecies = (id, nodeId, kind, rid) => {
    if (nodes.has(nodeId)) return;
    const sp = model.species.get(id);
    nodes.set(nodeId, {
      id: nodeId, kind, ref: id, reaction: rid || null,
      name: sp.name, compartment: sp.compartment, label: kind === 'side' ? sideKeyOf(model, id) : id,
    });
  };

  for (const rid of reactionIds) {
    const r = model.reactions.get(rid);
    const v = hasFlux ? (flux.get(rid) ?? 0) : null;
    const flipped = v !== null && v < 0;
    const belowCut = faint.has(rid);
    let linked = 0;
    const refs = [
      ...r.reactants.map(ref => ({ ...ref, role: 'reactant' })),
      ...r.products.map(ref => ({ ...ref, role: 'product' })),
    ];
    for (const ref of refs) {
      if (!speciesVisible(ref.species)) continue;
      if (speciesInScope && !speciesInScope.has(ref.species)) continue;
      let nodeId = ref.species;
      let kind = 'met';
      if (isSide(ref.species)) {
        if (opts.sideMode === 'hide') continue;
        if (opts.sideMode === 'dup') { nodeId = ref.species + '@' + rid; kind = 'side'; }
      }
      addSpecies(ref.species, nodeId, kind, rid);
      // Links point the way mass actually flows: reactant -> reaction -> product,
      // reversed when the reaction runs against its written direction.
      const intoReaction = (ref.role === 'reactant') !== flipped;
      links.push({
        source: intoReaction ? nodeId : rid,
        target: intoReaction ? rid : nodeId,
        reaction: rid,
        stoich: ref.stoich,
        v: v === null ? null : Math.abs(v),
        side: kind === 'side',
        belowCut,
      });
      linked++;
    }
    if (linked || rid === opts.focus) {
      nodes.set(rid, {
        id: rid, kind: 'rxn', ref: rid, name: r.name, label: rid,
        reversible: r.reversible, flipped, v: v === null ? null : Math.abs(v),
        compartment: null, belowCut,
      });
    }
  }
  if (opts.focus && model.species.has(opts.focus) && !nodes.has(opts.focus) && speciesVisible(opts.focus)) {
    addSpecies(opts.focus, opts.focus, 'met');
  }

  const totalShown = [...nodes.values()].filter(n => n.kind === 'rxn').length;
  let hiddenByFlux = cutByFlux.size;
  // In a neighbourhood the search stops at hidden reactions, so count what
  // the same neighbourhood would hold without the cut-off.
  if (opts.scope === 'hood' && !opts.showCut && hasFlux && opts.fluxRange) {
    hiddenByFlux = buildGraph(model, index, flux, { ...opts, showCut: true }).reactionsShown - totalShown;
  }
  return { nodes: [...nodes.values()], links, reactionsShown: totalShown, hiddenByFlux };
}

// Per-metabolite view of its reactions, in the direction they actually run.
export function speciesSummary(model, index, flux, speciesId) {
  const hasFlux = flux && flux.size > 0;
  const sp = model.species.get(speciesId);
  let turnover = 0;
  let net = 0;
  const rows = (index.speciesRxns.get(speciesId) || []).map(rid => {
    const r = model.reactions.get(rid);
    const asProduct = r.products.filter(p => p.species === speciesId).reduce((s, p) => s + p.stoich, 0);
    const asReactant = r.reactants.filter(p => p.species === speciesId).reduce((s, p) => s + p.stoich, 0);
    const v = hasFlux ? (flux.get(rid) ?? 0) : null;
    const netStoich = asProduct - asReactant;
    const produced = v === null ? netStoich > 0 : netStoich * v > 0;
    if (v !== null) {
      const rate = netStoich * v;
      net += rate;
      if (rate > 0) turnover += rate;
    }
    const key = baseKey(sp);
    const crosses = [...r.reactants, ...r.products].some(ref => {
      const other = model.species.get(ref.species);
      return other && other.id !== speciesId && baseKey(other) === key && other.compartment !== sp.compartment;
    });
    return {
      id: rid,
      role: crosses ? (produced ? 'imports' : 'exports') : (produced ? 'produces' : 'consumes'),
      reversible: r.reversible,
      flipped: v !== null && v < 0,
      v: v === null ? null : Math.abs(v),
    };
  });
  rows.sort((a, b) => (b.v ?? 0) - (a.v ?? 0) || a.id.localeCompare(b.id));
  return { species: sp, rows, turnover: hasFlux ? turnover : null, net: hasFlux ? net : null };
}

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(priority, value) {
    const a = this.items;
    a.push([priority, value]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest route between two species through reactions, as
 * [from, reaction, species, reaction, ..., to], or null.
 * Irreversible reactions only run forward. Side metabolites are never passed
 * through, and other hubs are penalised by degree. With `weighted` and flux
 * loaded, reactions carrying flux (|v| >=
 * threshold) run only in their flux direction and are strongly preferred.
 * If no directed route exists, retries ignoring direction (`undirected: true`).
 */
export function findPath(model, index, flux, from, to, { side, hiddenCompartments = new Set(), weighted = false, threshold = 1e-6 }) {
  if (!model.species.has(from) || !model.species.has(to) || from === to) return null;
  const hasFlux = weighted && flux && flux.size > 0;
  const isSide = id => side.has(sideKeyOf(model, id));

  const search = directed => {
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const heap = new MinHeap();
    heap.push(0, from);
    while (heap.size) {
      const [d, sp] = heap.pop();
      if (d > dist.get(sp)) continue;
      if (sp === to) break;
      if (sp !== from && isSide(sp)) continue;
      for (const rid of index.speciesRxns.get(sp) || []) {
        const r = model.reactions.get(rid);
        const v = hasFlux ? (flux.get(rid) ?? 0) : null;
        const active = v !== null && Math.abs(v) >= (threshold || 1e-12);
        let forward = true;
        let backward = !directed || r.reversible;
        if (directed && active) {
          forward = v > 0;
          backward = v < 0;
        }
        const stepCost = hasFlux && !active ? 25 : 1;
        const out = [];
        if (forward && r.reactants.some(x => x.species === sp)) out.push(...r.products);
        if (backward && r.products.some(x => x.species === sp)) out.push(...r.reactants);
        for (const ref of out) {
          const next = ref.species;
          const nsp = model.species.get(next);
          if (next === sp || !nsp || hiddenCompartments.has(nsp.compartment)) continue;
          if (next !== to && isSide(next)) continue;
          // Passing through a metabolite costs its degree (Croes et al. 2006),
          // so currency compounds the side list misses (GTP, ubiquinone...)
          // are avoided without a hand-made list.
          const nd = d + stepCost * (next === to ? 1 : Math.max(1, (index.speciesRxns.get(next) || []).length));
          if (nd < (dist.get(next) ?? Infinity)) {
            dist.set(next, nd);
            prev.set(next, [rid, sp]);
            heap.push(nd, next);
          }
        }
      }
    }
    if (!dist.has(to)) return null;
    const ids = [to];
    for (let cur = to; cur !== from;) {
      const [rid, p] = prev.get(cur);
      ids.push(rid, p);
      cur = p;
    }
    return ids.reverse();
  };

  const directed = search(true);
  if (directed) return { ids: directed, undirected: false };
  const any = search(false);
  return any ? { ids: any, undirected: true } : null;
}
