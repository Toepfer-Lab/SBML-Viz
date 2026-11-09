// Model layer: turns SBML (or the bundled example graph) into one plain
// structure the rest of the app works with. No DOM APIs, so it runs in a
// Web Worker and in Node tests.
//
// model = {
//   id, name,
//   compartments: Map<id, name>,
//   species:   Map<id, { id, name, compartment, boundary, formula, charge, sbo, refs, notes }>,
//   reactions: Map<id, { id, name, reversible, lower, upper, reactants, products, modifiers,
//                        genes, ec, subsystem, sbo, refs, notes }>,
//   groups: [{ id, name, kind, members: [id] }],
// }
// refs = [{ db, id, url }] from identifiers.org annotations.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// Attributes keyed by local name (fbc:charge -> charge); unprefixed names win.
function parseAttrs(src) {
  const out = {};
  for (const m of src.matchAll(ATTR)) {
    const i = m[1].indexOf(':');
    const local = i < 0 ? m[1] : m[1].slice(i + 1);
    if (i >= 0 && (m[1].startsWith('xmlns') || local in out)) continue;
    out[local] = decode(m[2] ?? m[3]);
  }
  return out;
}

export function parseRef(url) {
  const m = /^https?:\/\/identifiers\.org\/(.+)$/i.exec(url);
  if (!m) {
    let host = url;
    try { host = new URL(url).hostname; } catch { /* keep raw */ }
    return { db: host, id: url, url };
  }
  const path = m[1];
  const slash = path.indexOf('/');
  const colon = path.indexOf(':');
  // Legacy form identifiers.org/chebi/CHEBI:15422, current form identifiers.org/CHEBI:15422.
  const db = slash >= 0 && (colon < 0 || slash < colon) ? path.slice(0, slash) : path.slice(0, colon).toLowerCase();
  const id = slash >= 0 && (colon < 0 || slash < colon) ? path.slice(slash + 1) : path;
  return { db, id, url: url.replace(/^http:/, 'https:') };
}

// COBRA-style notes: <p>KEY: value</p>.
function noteEntry(text, notes) {
  const m = /^\s*([^:]{1,40}):\s*(.*?)\s*$/s.exec(text);
  if (m && m[2]) notes[m[1].trim().toUpperCase()] = m[2];
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Parse SBML text. `onProgress(fraction)` is called while scanning.
 */
export function parseSBML(text, onProgress) {
  if (!/<sbml[\s>]/.test(text.slice(0, 4096))) {
    throw new Error(/^\s*</.test(text) ? 'The file is XML but not SBML (no <sbml> element).' : 'The file is not valid XML.');
  }
  const params = new Map();
  const compartments = new Map();
  const species = new Map();
  const reactions = new Map();
  const geneLabels = new Map();
  const groups = [];
  const model = { id: 'model', name: 'model' };

  let entity = null;          // species or reaction being read
  let refList = null;         // reactants / products / modifiers of `entity`
  let group = null;
  let annotation = 0;         // depth inside <annotation> of `entity`
  let notes = 0;              // depth inside <notes> of `entity`
  let pText = null;           // text of the current notes <p>
  let gpaDepth = 0;           // inside fbc:geneProductAssociation
  let last = 0;
  let count = 0;

  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(text));) {
    if (pText !== null) pText += text.slice(last, m.index) + (m[1] ?? '');
    last = TOKEN.lastIndex;
    const name = m[3];
    if (!name) continue;
    if (++count % 4000 === 0 && onProgress) onProgress(m.index / text.length);
    const closing = m[2] === '/';
    const selfClosing = m[5] === '/';

    if (closing) {
      if (name === 'species' || name === 'reaction') { entity = null; refList = null; }
      else if (name === 'listOfReactants' || name === 'listOfProducts' || name === 'listOfModifiers') refList = null;
      else if (name === 'annotation' && annotation) annotation--;
      else if (name === 'notes' && notes) notes--;
      else if (name === 'p' && pText !== null) { noteEntry(decode(pText.replace(/<[^>]*>/g, '')), entity.notes); pText = null; }
      else if (name === 'group') group = null;
      else if (name === 'geneProductAssociation') gpaDepth = 0;
      continue;
    }

    const a = parseAttrs(m[4]);
    switch (name) {
      case 'model':
        model.id = a.id || 'model';
        model.name = a.name || model.id;
        break;
      case 'parameter':
        if (!entity) params.set(a.id, Number(a.value));
        break;
      case 'compartment':
        compartments.set(a.id, a.name || a.id);
        break;
      case 'species': {
        const sp = {
          id: a.id,
          name: a.name || a.id,
          compartment: a.compartment || compartmentFromId(a.id),
          boundary: a.boundaryCondition === 'true',
          formula: a.chemicalFormula || null,
          charge: a.charge !== undefined ? Number(a.charge) : null,
          sbo: a.sboTerm || null,
          refs: [],
          notes: {},
        };
        species.set(sp.id, sp);
        entity = selfClosing ? null : sp;
        break;
      }
      case 'reaction': {
        const lower = a.lowerFluxBound !== undefined && params.has(a.lowerFluxBound) ? params.get(a.lowerFluxBound) : null;
        const upper = a.upperFluxBound !== undefined && params.has(a.upperFluxBound) ? params.get(a.upperFluxBound) : null;
        const r = {
          id: a.id,
          name: a.name || a.id,
          // L3 requires `reversible`; L2 defaults it to true. FBC bounds win.
          reversible: lower !== null ? lower < 0 : a.reversible !== 'false',
          lower,
          upper,
          reactants: [],
          products: [],
          modifiers: [],
          genes: [],
          ec: [],
          subsystem: null,
          sbo: a.sboTerm || null,
          refs: [],
          notes: {},
        };
        reactions.set(r.id, r);
        entity = selfClosing ? null : r;
        break;
      }
      case 'listOfReactants': if (entity?.reactants) refList = entity.reactants; break;
      case 'listOfProducts': if (entity?.products) refList = entity.products; break;
      case 'listOfModifiers': if (entity?.modifiers) refList = entity.modifiers; break;
      case 'speciesReference':
      case 'modifierSpeciesReference':
        if (refList) {
          const st = a.stoichiometry === undefined || a.stoichiometry === '' ? 1 : Number(a.stoichiometry);
          refList.push({ species: a.species, stoich: Number.isFinite(st) ? st : 1 });
        }
        break;
      case 'annotation':
        if (entity && !selfClosing) annotation++;
        break;
      case 'notes':
        if (entity && !selfClosing) notes++;
        break;
      case 'p':
        if (notes && !selfClosing) pText = '';
        break;
      case 'li':
        if (annotation && a.resource) entity.refs.push(parseRef(a.resource));
        break;
      case 'geneProductAssociation':
        if (entity && !selfClosing) gpaDepth = 1;
        break;
      case 'geneProductRef':
        if (gpaDepth && entity?.genes && !entity.genes.includes(a.geneProduct)) entity.genes.push(a.geneProduct);
        break;
      case 'geneProduct':
        if (a.id) geneLabels.set(a.id, a.label || a.name || a.id);
        break;
      case 'group':
        group = { id: a.id || '', name: a.name || a.id || '', kind: a.kind || '', members: [] };
        groups.push(group);
        if (selfClosing) group = null;
        break;
      case 'member':
        if (group && a.idRef) group.members.push(a.idRef);
        break;
    }
  }
  onProgress?.(1);

  if (!species.size || !reactions.size) {
    throw new Error('The SBML model has no species or no reactions to draw.');
  }

  // Fold COBRA notes and annotations into first-class fields.
  for (const sp of species.values()) {
    if (!sp.formula && sp.notes.FORMULA) sp.formula = sp.notes.FORMULA;
    if (sp.charge === null && sp.notes.CHARGE !== undefined && Number.isFinite(Number(sp.notes.CHARGE))) sp.charge = Number(sp.notes.CHARGE);
  }
  const groupOf = new Map();
  for (const g of groups) for (const id of g.members) if (!groupOf.has(id)) groupOf.set(id, g.name);
  for (const r of reactions.values()) {
    r.genes = r.genes.map(g => geneLabels.get(g) || g);
    const ecs = new Set(r.refs.filter(x => x.db === 'ec-code').map(x => x.id));
    for (const key of ['EC NUMBER', 'EC_NUMBER', 'EC']) {
      for (const e of (r.notes[key] || '').split(/[\s,;]+/)) if (/^\d+\.[\d-]+\.[\d-]+\.[\w-]+$/.test(e)) ecs.add(e);
    }
    r.ec = [...ecs];
    r.subsystem = groupOf.get(r.id) || r.notes.SUBSYSTEM || null;
  }

  return { ...model, compartments, species, reactions, groups };
}

// Many models encode the compartment as an id suffix (GLN_p, M_atp_c).
export function compartmentFromId(id) {
  const i = id.lastIndexOf('_');
  return i > 0 ? id.slice(i + 1) : '';
}

// The bundled example is a pre-built graph, not SBML: group 1 = species,
// group 2 = reactions, link value = stoichiometry × flux. We recover the
// reaction flux as the largest |value| on its links, signed.
export function modelFromGraphJSON(graph, name = 'Bundled plant model') {
  const species = new Map();
  const reactions = new Map();
  const flux = new Map();
  const blank = () => ({ sbo: null, refs: [], notes: {} });
  for (const n of graph.nodes) {
    if (n.group === 1) {
      species.set(n.id, { id: n.id, name: n.id, compartment: compartmentFromId(n.id), boundary: false, formula: null, charge: null, ...blank() });
    } else {
      reactions.set(n.id, {
        id: n.id, name: n.id, reversible: false, lower: null, upper: null,
        reactants: [], products: [], modifiers: [], genes: [], ec: [], subsystem: null, ...blank(),
      });
    }
  }
  for (const l of graph.links) {
    const v = Number(l.value) || 0;
    let rid;
    if (reactions.has(l.target)) {
      rid = l.target;
      reactions.get(rid).reactants.push({ species: l.source, stoich: 1 });
    } else if (reactions.has(l.source)) {
      rid = l.source;
      reactions.get(rid).products.push({ species: l.target, stoich: 1 });
    } else {
      continue;
    }
    if (Math.abs(v) > Math.abs(flux.get(rid) || 0)) flux.set(rid, v);
  }
  const compartments = new Map();
  for (const s of species.values()) {
    if (!compartments.has(s.compartment)) compartments.set(s.compartment, s.compartment);
  }
  return { model: { id: 'bundled-example', name, compartments, species, reactions, groups: [] }, flux };
}

// Flux table: one row per reaction, `id,flux` (comma, semicolon or tab).
// A header row is skipped when its second cell is not a number.
export function parseFluxCSV(text) {
  const rows = new Map();
  let bad = 0;
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(/[,;\t]/).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    const v = Number(cells[1]);
    if (cells.length < 2 || cells[1] === '' || !Number.isFinite(v)) {
      if (rows.size || i > 0) bad++;
      continue;
    }
    rows.set(cells[0], v);
  }
  return { rows, bad };
}

// Match flux ids to reactions, tolerating the common `R_` prefix mismatch
// between COBRA exports and SBML ids.
export function matchFlux(model, rows) {
  const flux = new Map();
  const unmatched = [];
  for (const [id, v] of rows) {
    const candidates = [id, 'R_' + id, id.startsWith('R_') ? id.slice(2) : null];
    const hit = candidates.find(c => c && model.reactions.has(c));
    if (hit) flux.set(hit, v);
    else unmatched.push(id);
  }
  return { flux, unmatched };
}

// Stable key for remembering layouts per model.
export function modelKey(model) {
  let h = 0;
  const s = model.id + '|' + [...model.reactions.keys()].join(',');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return model.id + ':' + (h >>> 0).toString(36);
}
