import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromGraphJSON, parseFluxCSV, matchFlux } from '../js/model.js';
import { buildIndex, buildGraph, detectSide, speciesSummary, baseKey } from '../js/graph.js';

// A -> R1 -> B -> R2 -> C, with H2O as a hub on every reaction.
function toy() {
  const species = new Map();
  for (const id of ['A_c', 'B_c', 'C_p', 'H2O_c']) {
    species.set(id, { id, name: id, compartment: id.split('_')[1], boundary: false });
  }
  const r = (id, reactants, products, reversible = false) => [id, {
    id, name: id, reversible, lower: null, upper: null,
    reactants: reactants.map(s => ({ species: s, stoich: 1 })),
    products: products.map(s => ({ species: s, stoich: 1 })),
  }];
  const reactions = new Map([
    r('R1', ['A_c', 'H2O_c'], ['B_c']),
    r('R2', ['B_c'], ['C_p', 'H2O_c'], true),
    r('R3', ['C_p'], ['H2O_c']),
  ]);
  const compartments = new Map([['c', 'c'], ['p', 'p']]);
  return { id: 'toy', name: 'toy', species, reactions, compartments };
}

const base = { scope: 'whole', focus: null, hops: 1, sideMode: 'show', side: new Set(), threshold: 0, hiddenCompartments: new Set() };

test('whole model links follow written direction without flux', () => {
  const m = toy();
  const g = buildGraph(m, buildIndex(m), new Map(), base);
  assert.equal(g.nodes.length, 7);
  assert.ok(g.links.some(l => l.source === 'A_c' && l.target === 'R1'));
  assert.ok(g.links.some(l => l.source === 'R1' && l.target === 'B_c'));
  assert.ok(g.links.every(l => l.v === null));
});

test('negative flux flips link direction and marks the reaction', () => {
  const m = toy();
  const flux = new Map([['R1', 1], ['R2', -2], ['R3', 0]]);
  const g = buildGraph(m, buildIndex(m), flux, base);
  assert.ok(g.links.some(l => l.source === 'C_p' && l.target === 'R2' && l.v === 2));
  assert.equal(g.nodes.find(n => n.id === 'R2').flipped, true);
});

test('threshold hides low-flux reactions', () => {
  const m = toy();
  const flux = new Map([['R1', 1], ['R2', 1e-9], ['R3', 0]]);
  const g = buildGraph(m, buildIndex(m), flux, { ...base, threshold: 1e-6 });
  assert.deepEqual(g.nodes.filter(n => n.kind === 'rxn').map(n => n.id), ['R1']);
  assert.equal(g.reactionsShown, 1);
});

test('side metabolites can be duplicated per reaction or hidden', () => {
  const m = toy();
  const idx = buildIndex(m);
  assert.deepEqual(detectSide(idx, 1, 3), ['H2O']);
  const side = new Set(['H2O']);
  const dup = buildGraph(m, idx, new Map(), { ...base, side, sideMode: 'dup' });
  assert.deepEqual(dup.nodes.filter(n => n.kind === 'side').map(n => n.id).sort(), ['H2O_c@R1', 'H2O_c@R2', 'H2O_c@R3']);
  const hidden = buildGraph(m, idx, new Map(), { ...base, side, sideMode: 'hide' });
  assert.ok(!hidden.nodes.some(n => n.ref === 'H2O_c'));
});

test('neighbourhood does not expand through side metabolites', () => {
  const m = toy();
  const idx = buildIndex(m);
  const opts = { ...base, scope: 'hood', focus: 'A_c', hops: 1, side: new Set(['H2O']), sideMode: 'show' };
  const g = buildGraph(m, idx, new Map(), opts);
  // One hop from A: R1 and its species, but not R2/R3 via H2O.
  assert.deepEqual(g.nodes.filter(n => n.kind === 'rxn').map(n => n.id), ['R1']);
  const two = buildGraph(m, idx, new Map(), { ...opts, hops: 2 });
  assert.deepEqual(two.nodes.filter(n => n.kind === 'rxn').map(n => n.id).sort(), ['R1', 'R2']);
});

test('hidden compartments drop their species', () => {
  const m = toy();
  const g = buildGraph(m, buildIndex(m), new Map(), { ...base, hiddenCompartments: new Set(['p']) });
  assert.ok(!g.nodes.some(n => n.compartment === 'p'));
  assert.ok(g.nodes.some(n => n.id === 'R3')); // still linked to H2O_c
});

test('species summary computes turnover in actual direction', () => {
  const m = toy();
  const flux = new Map([['R1', 3], ['R2', -2], ['R3', 0]]);
  const s = speciesSummary(m, buildIndex(m), flux, 'B_c');
  assert.equal(s.turnover, 3 + 2);
  assert.deepEqual(s.rows.map(r => [r.id, r.role]), [['R1', 'produces'], ['R2', 'produces']]);
});

test('flux CSV: header, delimiters and R_ prefix matching', () => {
  const { rows, bad } = parseFluxCSV('reaction,flux\nR1,1.5\r\nR_R2;-2\n"R3"\t0\nR4,abc\n');
  assert.equal(rows.size, 3);
  assert.equal(bad, 1);
  const m = toy();
  const { flux, unmatched } = matchFlux(m, new Map([['R1', 1], ['R_R2', 2], ['X', 3]]));
  assert.deepEqual([...flux.keys()], ['R1', 'R2']);
  assert.deepEqual(unmatched, ['X']);
});

test('bundled example graph converts to model + signed flux', () => {
  const { model, flux } = modelFromGraphJSON({
    nodes: [{ id: 'A_c', group: 1 }, { id: 'B_p', group: 1 }, { id: 'R', group: 2 }],
    links: [{ source: 'A_c', target: 'R', value: -2 }, { source: 'R', target: 'B_p', value: -1 }],
  });
  assert.equal(model.species.size, 2);
  assert.deepEqual(model.reactions.get('R').products, [{ species: 'B_p', stoich: 1 }]);
  assert.equal(flux.get('R'), -2);
  assert.equal(baseKey(model.species.get('B_p')), 'B');
});

test('neighbourhood keeps the focus reactions below the cut-off, faint', async () => {
  const { buildIndex, buildGraph } = await import('../js/graph.js');
  const m = toy();
  const flux = new Map([['R1', 1e-9], ['R2', 1], ['R3', 1]]);
  const opts = { ...base, scope: 'hood', focus: 'A_c', hops: 2, threshold: 1e-6 };
  const g = buildGraph(m, buildIndex(m), flux, opts);
  const r1 = g.nodes.find(n => n.id === 'R1');
  assert.equal(r1.belowCut, true);
  assert.ok(!g.nodes.some(n => n.id === 'R2')); // not expanded through a faint reaction
  const all = buildGraph(m, buildIndex(m), flux, { ...opts, showCut: true });
  assert.ok(all.nodes.some(n => n.id === 'R2'));
});

test('path finding respects direction and avoids side metabolites', async () => {
  const { buildIndex, findPath } = await import('../js/graph.js');
  const m = toy();
  const idx = buildIndex(m);
  const side = new Set(['H2O']);
  assert.deepEqual(findPath(m, idx, new Map(), 'A_c', 'C_p', { side }).ids, ['A_c', 'R1', 'B_c', 'R2', 'C_p']);
  // R1 is irreversible, so C -> A only exists ignoring direction.
  const back = findPath(m, idx, new Map(), 'C_p', 'A_c', { side });
  assert.equal(back.undirected, true);
  assert.equal(findPath(m, idx, new Map(), 'A_c', 'A_c', { side }), null);
});
