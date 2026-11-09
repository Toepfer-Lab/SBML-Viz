// DOM rendering for the side panels. Elements that select something carry
// data-select="<id>"; main.js handles those clicks by delegation.
import { escapeHtml as esc, fluxColor } from './style.js';

export function formatFlux(v) {
  if (v === null || v === undefined) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a >= 0.01 && a < 1e4 ? v.toFixed(a < 1 ? 3 : 2) : v.toExponential(2);
}

export function renderResults(el, items, styles) {
  el.innerHTML = items.map(it => {
    const mark = it.kind === 'rxn'
      ? `<span class="mark rxn${it.reversible ? ' rev' : ''}"></span>`
      : `<span class="mark" style="background:${styles.get(it.compartment)?.color || '#C9CED8'}"></span>`;
    const meta = it.kind === 'rxn' ? 'reaction' : (styles.get(it.compartment)?.label || it.compartment).toLowerCase();
    return `<button class="result" data-select="${esc(it.id)}">${mark}<span class="id">${esc(it.id)}</span><span class="meta">${esc(meta)}</span></button>`;
  }).join('');
}

export function renderCompartments(el, styles, hidden, counts) {
  el.innerHTML = [...styles.values()]
    .filter(c => counts.get(c.id))
    .map(c => `<button class="chip" data-compartment="${esc(c.id)}" aria-pressed="${!hidden.has(c.id)}"><span class="dot" style="background:${c.color}"></span>${esc(c.label)}</button>`)
    .join('');
}

export function renderSideList(el, keys) {
  el.innerHTML = keys.length
    ? keys.map(k => `<button class="chip mono" data-side="${esc(k)}" aria-pressed="true" aria-label="Remove ${esc(k)} from side metabolites">${esc(k)}</button>`).join('')
    : '<span class="muted small">None. Add one below.</span>';
}

function bar(v, max) {
  if (!v || !max) return '<span class="bar"></span>';
  const t = Math.max(0.04, Math.min(1, Math.log10(1 + (9 * v) / max)));
  return `<span class="bar"><span style="width:${(t * 100).toFixed(0)}%;background:${fluxColor(t)}"></span></span>`;
}

function footer({ canExpand, scope }, extra = '') {
  const expand = scope === 'hood'
    ? `<button class="btn" data-action="expand" ${canExpand ? '' : 'disabled'}>Expand 1 hop</button>`
    : '<button class="btn" data-action="hood">Show neighbourhood</button>';
  return `${extra}<div class="footer">${expand}<button class="btn" data-action="clear">Clear selection</button></div>`;
}

const DB_LABELS = {
  'kegg.compound': 'KEGG Compound', 'kegg.reaction': 'KEGG Reaction', 'kegg.drug': 'KEGG Drug', 'kegg.glycan': 'KEGG Glycan',
  chebi: 'ChEBI', 'metanetx.chemical': 'MetaNetX', 'metanetx.reaction': 'MetaNetX', 'bigg.metabolite': 'BiGG', 'bigg.reaction': 'BiGG',
  rhea: 'Rhea', 'ec-code': 'EC', reactome: 'Reactome', biocyc: 'BioCyc', hmdb: 'HMDB', 'seed.compound': 'SEED', 'seed.reaction': 'SEED',
  inchikey: 'InChIKey', lipidmaps: 'LIPID MAPS', 'pubchem.compound': 'PubChem', sbo: 'SBO', uniprot: 'UniProt', 'ncbigene': 'NCBI Gene',
};
// Most useful first; the rest follow alphabetically.
const DB_ORDER = ['ec-code', 'kegg.compound', 'kegg.reaction', 'chebi', 'rhea', 'metanetx.chemical', 'metanetx.reaction', 'bigg.metabolite', 'bigg.reaction', 'biocyc', 'reactome'];
const SHOWN_PER_DB = 3;

function renderRefs(refs) {
  if (!refs.length) return '';
  const byDb = new Map();
  for (const r of refs) (byDb.get(r.db) || byDb.set(r.db, []).get(r.db)).push(r);
  const rank = db => (DB_ORDER.includes(db) ? DB_ORDER.indexOf(db) : DB_ORDER.length);
  const dbs = [...byDb.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const link = r => `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.id)}</a>`;
  const rows = dbs.map(db => {
    const list = byDb.get(db);
    const more = list.length > SHOWN_PER_DB
      ? `<details><summary>+${list.length - SHOWN_PER_DB} more</summary>${list.slice(SHOWN_PER_DB).map(link).join('')}</details>`
      : '';
    return `<div class="ref-row"><dt>${esc(DB_LABELS[db] || db)}</dt><dd>${list.slice(0, SHOWN_PER_DB).map(link).join('')}${more}</dd></div>`;
  }).join('');
  return `<section class="stack-8"><h2 class="eyebrow">Database links</h2><dl class="refs">${rows}</dl></section>`;
}

function properties(pairs) {
  const rows = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!rows.length) return '';
  return `<dl class="props">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

const formula = f => esc(f).replace(/(\d+)/g, '<sub>$1</sub>');

export function renderEmpty(el, model, flux) {
  el.innerHTML = `
    <div class="stack-4">
      <span class="eyebrow">Model</span>
      <span class="title">${esc(model.id)}</span>
      ${model.name !== model.id ? `<span class="muted">${esc(model.name)}</span>` : ''}
    </div>
    <dl class="facts">
      <div><dt>Species</dt><dd>${model.species.size}</dd></div>
      <div><dt>Reactions</dt><dd>${model.reactions.size}</dd></div>
      <div><dt>Compartments</dt><dd>${model.compartments.size}</dd></div>
      <div><dt>Flux values</dt><dd>${flux.size || '–'}</dd></div>
    </dl>
    <p class="empty">Click a node, or search on the left, to inspect a species or reaction.</p>`;
}

export function renderSpecies(el, summary, ctx) {
  const { species: sp, rows, turnover, net } = summary;
  const comp = ctx.styles.get(sp.compartment)?.label || sp.compartment;
  const hasFlux = turnover !== null;
  const max = Math.max(0, ...rows.map(r => r.v || 0));
  const second = sp.boundary
    ? `<div><dt>Net flux</dt><dd class="flux-text">${formatFlux(net)}</dd></div>`
    : `<div><dt>Turnover</dt><dd class="flux-text">${hasFlux ? formatFlux(turnover) : '–'}</dd></div>`;
  const shown = rows.slice(0, 60);
  el.innerHTML = `
    <div class="stack-4">
      <span class="eyebrow">${ctx.isSide ? 'Side metabolite' : 'Selected metabolite'}</span>
      <span class="title">${esc(sp.id)}</span>
      <span class="muted">${sp.name !== sp.id ? esc(sp.name) + ' · ' : ''}${esc(comp)}</span>
    </div>
    <dl class="facts">
      <div><dt>Connected reactions</dt><dd>${rows.length}</dd></div>
      ${second}
    </dl>
    ${properties([
      ['Formula', sp.formula ? `<span class="mono">${formula(sp.formula)}</span>` : null],
      ['Charge', sp.charge ?? null],
      ['Boundary', sp.boundary ? 'yes' : null],
      ['SBO', sp.sbo ? `<a class="mono" href="https://identifiers.org/${esc(sp.sbo)}" target="_blank" rel="noopener noreferrer">${esc(sp.sbo)}</a>` : null],
    ])}
    ${hasFlux ? '<p class="muted small" style="margin-top:-8px">Turnover = Σ production = Σ consumption at steady state. Net flux is shown only for boundary species.</p>' : ''}
    <section class="stack-8">
      <h2 class="eyebrow">Reactions${hasFlux ? ' · by actual flow' : ''}</h2>
      ${shown.map(r => `
        <button class="rxn-row" data-select="${esc(r.id)}">
          <span class="top"><span class="id">${esc(r.id)}</span><span class="role">${r.role}${hasFlux ? ' · ' + formatFlux(r.v) : ''}</span></span>
          <span class="tags"><span>${r.reversible ? 'reversible' : 'irreversible'}</span>${r.flipped ? '<span>runs against written direction</span>' : ''}</span>
          ${hasFlux ? bar(r.v, max) : ''}
        </button>`).join('')}
      ${rows.length > shown.length ? `<span class="muted small">+ ${rows.length - shown.length} more</span>` : ''}
    </section>
    ${renderRefs(sp.refs || [])}
    ${footer(ctx, `<div class="footer"><button class="btn" data-path-from="${esc(sp.id)}">Path from here</button><button class="btn" data-path-to="${esc(sp.id)}">Path to here</button></div>`)}`;
}

export function renderReaction(el, r, ctx) {
  const v = ctx.flux.size ? (ctx.flux.get(r.id) ?? 0) : null;
  const side = refs => refs.map(ref =>
    `${ref.stoich !== 1 ? ref.stoich + ' ' : ''}<button data-select="${esc(ref.species)}">${esc(ref.species)}</button>`).join(' + ') || '∅';
  // Placeholder gene ids like "NA" mean "no association".
  const genes = (r.genes || []).filter(g => g && !/^(NA|N\/A|none|unknown)$/i.test(g));
  const bounds = r.lower !== null || r.upper !== null ? `[${formatFlux(r.lower)}, ${formatFlux(r.upper)}]` : (r.reversible ? 'reversible' : 'irreversible');
  el.innerHTML = `
    <div class="stack-4">
      <span class="eyebrow">Selected reaction</span>
      <span class="title">${esc(r.id)}</span>
      ${r.name !== r.id ? `<span class="muted">${esc(r.name)}</span>` : ''}
    </div>
    <dl class="facts">
      <div><dt>Flux v</dt><dd class="flux-text">${formatFlux(v)}</dd></div>
      <div><dt>Bounds</dt><dd style="font-size:14px">${bounds}</dd></div>
    </dl>
    <div class="tags"><span>${r.reversible ? 'reversible' : 'irreversible'}</span>${v !== null && v < 0 ? '<span>runs against written direction</span>' : ''}</div>
    <section class="stack-8">
      <h2 class="eyebrow">Equation</h2>
      <p class="equation">${side(r.reactants)} ${r.reversible ? '⇌' : '→'} ${side(r.products)}</p>
    </section>
    ${properties([
      ['EC', (r.ec || []).length ? r.ec.map(e => `<a class="mono" href="https://identifiers.org/ec-code:${esc(e)}" target="_blank" rel="noopener noreferrer">${esc(e)}</a>`).join(' ') : null],
      ['Subsystem', r.subsystem ? esc(r.subsystem) : null],
      ['Genes', genes.length ? `<span class="mono">${genes.slice(0, 8).map(esc).join(', ')}${genes.length > 8 ? ` +${genes.length - 8}` : ''}</span>` : null],
      ['Modifiers', (r.modifiers || []).length ? r.modifiers.map(ref => `<button data-select="${esc(ref.species)}">${esc(ref.species)}</button>`).join(' ') : null],
      ['SBO', r.sbo ? `<a class="mono" href="https://identifiers.org/${esc(r.sbo)}" target="_blank" rel="noopener noreferrer">${esc(r.sbo)}</a>` : null],
    ])}
    ${renderRefs((r.refs || []).filter(x => x.db !== 'ec-code'))}
    ${footer(ctx)}`;
}

export function renderPathResult(el, result, model, flux) {
  if (!result) {
    el.innerHTML = '';
    return;
  }
  if (result.error) {
    el.innerHTML = `<p class="muted small">${esc(result.error)}</p>`;
    return;
  }
  const reactions = result.ids.filter(id => model.reactions.has(id));
  const inactive = flux.size ? reactions.filter(id => !flux.get(id)).length : 0;
  const notes = [];
  if (result.undirected) notes.push('No route follows reaction directions; this one ignores them.');
  if (inactive) notes.push(`${inactive} of its reactions carry no flux.`);
  el.innerHTML = `
    <p class="small"><span class="strong">${reactions.length} reaction${reactions.length === 1 ? '' : 's'}</span>${notes.length ? ` <span class="muted">· ${notes.map(esc).join(' ')}</span>` : ''}</p>
    <ol class="path-steps">${result.ids.map(id => {
      const isRxn = model.reactions.has(id);
      return `<li class="${isRxn ? 'rxn' : 'met'}"><button data-select="${esc(id)}">${esc(id)}</button></li>`;
    }).join('')}</ol>`;
}

// --- ID decoding table -----------------------------------------------------------------

const idCell = (id, selectable) => (selectable
  ? `<button class="link-btn mono" data-select="${esc(id)}" title="Show in the graph">${esc(id)}</button>`
  : `<span class="mono">${esc(id)}</span>`);
const findBtn = (text, find) => `<button class="link-btn mono" data-find="${esc(find)}" title="Show both rows">${esc(text)}</button>`;

export function decodeRow(e, i, rows) {
  let status;
  if (e.clash) {
    status = `<span class="problem-text">⚠ Clash: ${esc(e.clash.layer)} decoding skipped, as it would turn this ID into ${findBtn(e.clash.as, e.clash.as)}, the same ID as ${findBtn(e.clash.with, e.clash.as)}.</span>`;
  } else if (e.clashedBy.length) {
    status = `<span class="problem-text">⚠ Clash partner: ${e.clashedBy.map(id => findBtn(id, e.shown)).join(', ')} would decode to this ID too, so that decoding step is skipped there.</span>`;
  } else if (e.raw !== e.shown) {
    status = `<span class="muted">Decoded (${esc(e.applied.join(' + '))})</span>`;
  } else {
    status = '<span class="muted">Unchanged</span>';
  }
  const cls = [];
  if (e.clash || e.clashedBy.length) cls.push('problem');
  if (e.group) {
    cls.push('grouped');
    if (rows[i - 1]?.group !== e.group) cls.push('group-first');
    if (rows[i + 1]?.group !== e.group) cls.push('group-last');
  }
  return `<tr${cls.length ? ` class="${cls.join(' ')}"` : ''}><td class="muted kind">${e.kind}</td><td><span class="mono">${esc(e.raw)}</span></td>`
    + `<td>${idCell(e.shown, e.kind !== 'gene')}</td><td>${status}</td></tr>`;
}

const HOW = {
  exact: 'Matched exactly',
  prefix: 'Matched with/without the R_ prefix',
  sbml: 'Matched the ID as written in the SBML file',
  decoded: 'Matched after decoding the IDs',
};

export function fluxMatchRow(e) {
  let status;
  if (e.status === 'ambiguous') {
    status = `<span class="problem-text">⚠ Skipped: fits ${e.candidates.length} reactions once decoded (${e.candidates.map(id => idCell(id, true)).join(', ')})</span>`;
  } else if (e.status === 'unmatched') {
    status = '<span class="problem-text">⚠ No reaction with this ID</span>';
  } else {
    status = `<span class="muted">${HOW[e.how]}</span>`;
  }
  return `<tr${e.reaction ? '' : ' class="problem"'}><td><span class="mono">${esc(e.id)}</span></td>`
    + `<td>${e.reaction ? idCell(e.reaction, true) : '<span class="muted">–</span>'}</td><td>${status}</td></tr>`;
}
