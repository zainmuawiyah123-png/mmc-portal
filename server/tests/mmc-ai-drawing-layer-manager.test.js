'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLayerCatalog, createUserLayer, updateLayer, deleteUserLayer,
  assignEntityLayer
} = require('../src/lib/mmc-ai/drawing-layer-manager');

test('catalogs native DXF layers and counts their entities without guessing discipline', () => {
  const layers = buildLayerCatalog({ rows: [
    { layer: 'STR-COLS' }, { layer: 'STR-COLS' }, { layer: 'A-WALL' }, { layer: '' }
  ] });
  assert.equal(layers.find(x => x.name === 'STR-COLS').entityCount, 2);
  assert.equal(layers.find(x => x.name === 'STR-COLS').source, 'native');
  assert.deepEqual(layers.find(x => x.name === 'STR-COLS').classification, {});
  assert.equal(layers.find(x => x.name === '0').entityCount, 1);
});

test('supports user-created layers with explicit engineering classification', () => {
  const layers = createUserLayer([], {
    name: 'MMC-STRUCTURAL-REVIEW', color: '#336699',
    classification: { discipline: 'structural', system: 'frame', elementType: 'column', measurements: ['volume_m3'] }
  });
  assert.equal(layers[0].source, 'user');
  assert.equal(layers[0].classification.discipline, 'structural');
  assert.throws(() => createUserLayer(layers, { name: 'mmc-structural-review' }), /already exists/);
});

test('supports visibility, color and classification edits without mutating source', () => {
  const native = buildLayerCatalog({ rows: [{ layer: 'A-WALL' }] });
  const updated = updateLayer(native, native[0].id, {
    visible: false, color: '#abcdef',
    classification: { discipline: 'architectural', system: 'partition', elementType: 'wall', measurements: ['area_m2'] }
  });
  assert.equal(updated[0].visible, false);
  assert.equal(updated[0].color, '#abcdef');
  assert.equal(native[0].visible, true);
  assert.throws(() => deleteUserLayer(updated, native[0].id), /Native CAD layers/);
});

test('allows deletion only for user layers and keeps entity reassignment as an overlay', () => {
  const layers = createUserLayer([], { name: 'Review' });
  assert.equal(deleteUserLayer(layers, layers[0].id).length, 0);
  const once = assignEntityLayer([], 'DOC:A1:ENTITY:7', layers[0].id);
  const twice = assignEntityLayer(once, 'DOC:A1:ENTITY:7', 'native:str-cols');
  assert.equal(twice.length, 1);
  assert.equal(twice[0].targetLayerId, 'native:str-cols');
});

test('rejects invalid disciplines, colors, and unsafe layer names', () => {
  assert.throws(() => createUserLayer([], { name: 'bad\nname' }), /invalid/);
  const layers = createUserLayer([], { name: 'Review' });
  assert.throws(() => updateLayer(layers, layers[0].id, { color: 'red' }), /hex color/);
  assert.throws(() => updateLayer(layers, layers[0].id, {
    classification: { discipline: 'guesswork' }
  }), /Unsupported discipline/);
});
