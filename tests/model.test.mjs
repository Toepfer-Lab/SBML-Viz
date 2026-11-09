import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSBML, parseRef } from '../js/model.js';

const SBML = `<?xml version="1.0" encoding="UTF-8"?>
<sbml xmlns="http://www.sbml.org/sbml/level3/version1/core" xmlns:fbc="http://www.sbml.org/sbml/level3/version1/fbc/version2" xmlns:groups="http://www.sbml.org/sbml/level3/version1/groups/version1" level="3" version="1">
  <model id="toy" name="Toy &amp; model">
    <listOfCompartments><compartment id="c" name="cytosol"/></listOfCompartments>
    <listOfSpecies>
      <species id="M_atp_c" name="ATP" compartment="c" boundaryCondition="false" fbc:charge="-4" fbc:chemicalFormula="C10H12N5O13P3" sboTerm="SBO:0000247" metaid="m1">
        <annotation><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description><bqbiol:is xmlns:bqbiol="http://biomodels.net/biology-qualifiers/"><rdf:Bag>
          <rdf:li rdf:resource="https://identifiers.org/kegg.compound/C00002"/>
          <rdf:li rdf:resource="http://identifiers.org/CHEBI:30616"/>
        </rdf:Bag></bqbiol:is></rdf:Description></rdf:RDF></annotation>
      </species>
      <species id="M_adp_c" name="ADP" compartment="c" boundaryCondition="false"/>
      <!-- a comment with <species id="fake"/> inside -->
    </listOfSpecies>
    <listOfParameters>
      <parameter id="lb" value="-1000"/><parameter id="ub" value="1000"/>
    </listOfParameters>
    <listOfReactions>
      <reaction id="R_ATPase" name="ATPase" reversible="false" fbc:lowerFluxBound="lb" fbc:upperFluxBound="ub">
        <notes><body xmlns="http://www.w3.org/1999/xhtml"><p>EC Number: 3.6.1.3</p><p>SUBSYSTEM: Energy</p></body></notes>
        <listOfReactants><speciesReference species="M_atp_c" stoichiometry="2"/></listOfReactants>
        <listOfProducts><speciesReference species="M_adp_c"/></listOfProducts>
        <fbc:geneProductAssociation><fbc:or><fbc:geneProductRef fbc:geneProduct="G_1"/><fbc:geneProductRef fbc:geneProduct="G_2"/></fbc:or></fbc:geneProductAssociation>
      </reaction>
    </listOfReactions>
    <fbc:listOfGeneProducts><fbc:geneProduct fbc:id="G_1" fbc:label="Solyc01g000010"/></fbc:listOfGeneProducts>
    <groups:listOfGroups><groups:group groups:id="g1" groups:name="Glycolysis" groups:kind="partonomy"><groups:listOfMembers><groups:member groups:idRef="R_ATPase"/></groups:listOfMembers></groups:group></groups:listOfGroups>
  </model>
</sbml>`;

test('parses species, reactions, fbc bounds and stoichiometry', () => {
  const m = parseSBML(SBML);
  assert.equal(m.name, 'Toy & model');
  assert.equal(m.species.size, 2);
  const r = m.reactions.get('R_ATPase');
  assert.equal(r.reversible, true); // fbc lower bound < 0 wins over reversible="false"
  assert.equal(r.lower, -1000);
  assert.deepEqual(r.reactants, [{ species: 'M_atp_c', stoich: 2 }]);
  assert.deepEqual(r.products, [{ species: 'M_adp_c', stoich: 1 }]);
});

test('reads annotations, notes, genes and groups', () => {
  const m = parseSBML(SBML);
  const atp = m.species.get('M_atp_c');
  assert.equal(atp.formula, 'C10H12N5O13P3');
  assert.equal(atp.charge, -4);
  assert.deepEqual(atp.refs.map(x => [x.db, x.id]), [['kegg.compound', 'C00002'], ['chebi', 'CHEBI:30616']]);
  assert.equal(atp.refs[1].url, 'https://identifiers.org/CHEBI:30616');
  const r = m.reactions.get('R_ATPase');
  assert.deepEqual(r.ec, ['3.6.1.3']);
  assert.deepEqual(r.genes, ['Solyc01g000010', 'G_2']);
  assert.equal(r.subsystem, 'Glycolysis');
});

test('rejects non-SBML input', () => {
  assert.throws(() => parseSBML('<html></html>'), /not SBML/);
  assert.throws(() => parseSBML('hello'), /not valid XML/);
});

test('parseRef handles legacy and current identifiers.org forms', () => {
  assert.deepEqual(parseRef('https://identifiers.org/ec-code/1.1.1.1'), { db: 'ec-code', id: '1.1.1.1', url: 'https://identifiers.org/ec-code/1.1.1.1' });
  assert.equal(parseRef('https://identifiers.org/biocyc/META:ATP').id, 'META:ATP');
  assert.equal(parseRef('https://www.ebi.ac.uk/chebi/x').db, 'www.ebi.ac.uk');
});

test('both encodings decode like cobrapy and the COBRA Toolbox wrote them', async () => {
  const { cobraDecode, legacyDecode } = await import('../js/model.js');
  assert.equal(cobraDecode('M_P_C00001__91__m__93__', 'M_'), 'P_C00001[m]');
  assert.equal(cobraDecode('R_H_1__46__5__46__1__46__34_RXN_c', 'R_'), 'H_1.5.1.34_RXN_c');
  assert.equal(cobraDecode('G_At1g01__SBML_DOT__1', 'G_'), 'At1g01.1');
  assert.equal(cobraDecode('H_1_PERIOD_10_RXN', 'R_'), 'H_1_PERIOD_10_RXN'); // cobrapy keeps tokens
  assert.equal(legacyDecode('H_1_PERIOD_10_PERIOD_2_RXN'), 'H_1.10.2_RXN');
  assert.equal(legacyDecode('glc_DASH_D_LSQBKT_c_RSQBKT_'), 'glc-D[c]');
});

const sp = (id, compartment = 'm') => [id, { id, name: id, compartment, refs: [], notes: {} }];
const rxn = (id, reactants, products = [], genes = []) => [id, {
  id, name: id, reversible: false,
  reactants: reactants.map(species => ({ species, stoich: 1 })), products: products.map(species => ({ species, stoich: 1 })),
  modifiers: [], genes,
}];

test('decoding renames the whole model and flux matches in every form', async () => {
  const { findEncodings, decodeModelIds, matchFlux } = await import('../js/model.js');
  const raw = {
    id: 'm', species: new Map([sp('M_A__91__m__93__'), sp('M_B__91__m__93__')]),
    reactions: new Map([rxn('R_X__46__1', ['M_A__91__m__93__'], ['M_B__91__m__93__'], ['G_g1__SBML_DOT__2']), rxn('R_Y_PERIOD_2', ['M_B__91__m__93__'])]),
    groups: [{ id: 'g', name: 'g', members: ['R_X__46__1'] }],
  };
  assert.deepEqual(findEncodings(raw), { cobra: 4, legacy: 1 });
  const { model, entries } = decodeModelIds(raw);
  assert.deepEqual([...model.reactions.keys()], ['X.1', 'Y.2']);
  assert.deepEqual(entries.find(e => e.raw === 'R_Y_PERIOD_2').applied, ['cobrapy', 'COBRA Toolbox']);
  const r = model.reactions.get('X.1');
  assert.equal(r.name, 'X.1');
  assert.deepEqual(r.reactants.map(x => x.species), ['A[m]']);
  assert.deepEqual(r.genes, ['g1.2']);
  assert.deepEqual(model.groups[0].members, ['X.1']);
  // cobrapy-only keeps the token, as cobrapy shows it.
  assert.ok(decodeModelIds(raw, { legacy: false }).model.reactions.has('Y_PERIOD_2'));
  const sbml = new Map([['X.1', 'R_X__46__1'], ['Y.2', 'R_Y_PERIOD_2']]);
  const { entries: rows } = matchFlux(model, [['X.1', 1], ['R_X__46__1', 1], ['Y_PERIOD_2', 2], ['Y__46__2', 2], ['Z', 0]], id => sbml.get(id));
  assert.deepEqual(rows.map(e => [e.reaction, e.how, e.status]), [
    ['X.1', 'exact', 'matched'], ['X.1', 'sbml', 'matched'], ['Y.2', 'sbml', 'matched'], ['Y.2', 'decoded', 'matched'], [null, null, 'unmatched'],
  ]);
});

test('a decoding layer is skipped only for the ids it would make clash', async () => {
  const { decodeModelIds, matchFlux } = await import('../js/model.js');
  // As in a real model: H_6_PERIOD_2 and H_6__46__2 both decode to H_6.2.
  const raw = {
    id: 'm', species: new Map([sp('M_ATP', 'c'), sp('M_glc', 'c')]),
    reactions: new Map([rxn('R_ATP', ['M_glc']), rxn('R_H_6_PERIOD_2', ['M_glc']), rxn('R_H_6__46__2', ['M_glc'])]),
  };
  const { model, entries } = decodeModelIds(raw);
  const by = id => entries.find(e => e.raw === id);
  // Species ATP and reaction ATP would share an id: both keep their SBML form.
  assert.ok(model.species.has('M_ATP') && model.reactions.has('R_ATP'));
  assert.equal(by('M_ATP').clash.layer, 'cobrapy');
  assert.equal(model.reactions.get('R_ATP').reactants[0].species, 'glc');
  // Only the COBRA Toolbox step is undone, and only for the id it changed.
  assert.equal(by('R_H_6_PERIOD_2').shown, 'H_6_PERIOD_2');
  assert.deepEqual(by('R_H_6_PERIOD_2').clash, { layer: 'COBRA Toolbox', with: 'R_H_6__46__2', as: 'H_6.2' });
  assert.equal(by('R_H_6__46__2').shown, 'H_6.2');
  assert.deepEqual(by('R_H_6__46__2').clashedBy, ['R_H_6_PERIOD_2']);
  // Each of the pair still matches its own flux row.
  const sbml = new Map(entries.map(e => [e.shown, e.raw]));
  const rows = matchFlux(model, [['H_6_PERIOD_2', 1], ['H_6.2', 2]], id => sbml.get(id)).entries;
  assert.deepEqual(rows.map(e => e.reaction), ['H_6_PERIOD_2', 'H_6.2']);
  // Shown as written, a flux id that fits both only once decoded matches neither.
  const plain = decodeModelIds(raw, { cobra: false, legacy: false }).model;
  const amb = matchFlux(plain, [['H_6.2', 1]]).entries[0];
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.candidates, ['R_H_6_PERIOD_2', 'R_H_6__46__2']);
});

test('ids that clash share a group, whichever side they are on', async () => {
  const { decodeModelIds } = await import('../js/model.js');
  const raw = {
    id: 'm', species: new Map([sp('M_glc', 'c')]),
    reactions: new Map([rxn('R_A_PERIOD_1', ['M_glc']), rxn('R_A__46__1', ['M_glc']), rxn('R_A_DASH_1', ['M_glc']), rxn('R_B', ['M_glc'])]),
  };
  const { entries } = decodeModelIds(raw);
  const group = id => entries.find(e => e.raw === id).group;
  assert.ok(group('R_A_PERIOD_1'));
  assert.equal(group('R_A_PERIOD_1'), group('R_A__46__1'));
  assert.equal(group('R_A_DASH_1'), null); // A-1 clashes with nothing
  assert.equal(group('R_B'), null);
});
