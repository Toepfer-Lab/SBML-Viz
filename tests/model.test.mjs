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
