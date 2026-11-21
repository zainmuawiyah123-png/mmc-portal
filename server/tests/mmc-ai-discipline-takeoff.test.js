'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { takeoffDxf } = require('../src/lib/mmc-ai/dxf-takeoff');
const { classifyLayer, summarizeByDiscipline } = require('../src/lib/mmc-ai/discipline-layer-classifier');
const { proposeDisciplineQuantities } = require('../src/lib/mmc-ai/discipline-quantity-rules');

function dxf(entities, units = 6) {
  return ['0','SECTION','2','HEADER','9','$INSUNITS','70',String(units),'0','ENDSEC',
    '0','SECTION','2','ENTITIES',entities,'0','ENDSEC','0','EOF'].join('\n');
}
test('DXF layer classification and measurement rules are connected end-to-end', () => {
  const entities = [
    ['0','LWPOLYLINE','8','A-FLOOR','70','1','10','0','20','0','10','4','20','0','10','4','20','3','10','0','20','3'].join('\n'),
    ['0','LINE','8','A-WALL','10','0','20','0','11','4','21','0'].join('\n'),
    ['0','LINE','8','E-LIGHT','10','0','20','0','11','1','21','0'].join('\n')
  ].join('\n');
  const measured = takeoffDxf(dxf(entities));
  const rows = measured.rows.map(row => {
    const c = classifyLayer(row.layer);
    return { ...row, discipline: c.discipline, disciplineCategory: c.category, disciplineBasis: c.basis, disciplineSource: c.source };
  });
  const summary = summarizeByDiscipline(rows);
  const proposals = proposeDisciplineQuantities(rows);
  assert.equal(summary.find(x => x.discipline === 'architectural').categories.some(x => x.category === 'floors'), true);
  assert.equal(proposals.summary.proposed, 2);
  assert.equal(proposals.summary.incomplete, 1);
  assert.equal(proposals.results.find(x => x.category === 'floors').proposed[0].value, 12);
  assert.equal(proposals.results.find(x => x.category === 'walls').status, 'incomplete');
  assert.equal(proposals.results.find(x => x.category === 'walls').approvalEligible, false);
});
test('explicit layer mapping overrides automatic classification', () => {
  const mapped = classifyLayer('A-WALL', { 'A-WALL': { discipline: 'structural', category: 'beams', basis: 'linework_length' } });
  assert.equal(mapped.discipline, 'structural');
  assert.equal(mapped.category, 'beams');
  assert.equal(mapped.source, 'user_map');
});
test('unknown and annotation layers are not promoted into quantity proposals', () => {
  assert.equal(classifyLayer('DIM-TEXT').basis, 'excluded');
  assert.equal(classifyLayer('MYSTERY_LAYER').discipline, 'unclassified');
});

test('wall quantities remain incomplete until project dimensions are supplied', () => {
  const measured = takeoffDxf(dxf(['0','LINE','8','A-WALL','10','0','20','0','11','4','21','0'].join('\n')));
  const classified = measured.rows.map(row => {
    const c = classifyLayer(row.layer);
    return { ...row, discipline: c.discipline, disciplineCategory: c.category, disciplineBasis: c.basis, disciplineSource: c.source };
  });
  const missing = proposeDisciplineQuantities(classified);
  assert.equal(missing.results[0].status, 'incomplete');
  const supplied = proposeDisciplineQuantities(classified, {
    byCategory: { walls: { heightM: 3, thicknessMm: 200 } }
  });
  const wall = supplied.results.find(x => x.category === 'walls');
  assert.equal(wall.status, 'proposed');
  assert.equal(wall.proposed.find(x => x.key === 'grossAreaM2').value, 12);
  assert.equal(wall.proposed.find(x => x.key === 'netVolumeM3').value, 2.4);
  assert.equal(wall.approvalEligible, false);
});
