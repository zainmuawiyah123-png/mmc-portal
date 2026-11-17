'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBboxLayout, decodeXml } = require('../src/lib/mmc-ai/pdf-text-spatial-extract');

test('decodes XML entities in extracted PDF words', () => {
  assert.equal(decodeXml('A &amp; B &#x3A6;'), 'A & B Φ');
});

test('preserves page dimensions and word bounding boxes from Poppler bbox layout', () => {
  const xml = '<doc><page width="612.0" height="792.0"><flow><block><line><word xMin="100.0" yMin="120.0" xMax="150.0" yMax="132.0">6000</word><word xMin="155.0" yMin="120.0" xMax="170.0" yMax="132.0">mm</word></line></block></flow></page></doc>';
  const pages = parseBboxLayout(xml);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].width, 612);
  assert.equal(pages[0].height, 792);
  assert.equal(pages[0].wordCount, 2);
  assert.deepEqual(pages[0].words[0], { text: '6000', box: { xMin: 100, yMin: 120, xMax: 150, yMax: 132 } });
  assert.deepEqual(pages[0].lines, ['6000 mm']);
  assert.equal(pages[0].coordinateSystem, 'Poppler pdftotext bbox coordinates; origin at page top-left; PDF points');
});

test('returns an empty page list for malformed or empty bbox output', () => {
  assert.deepEqual(parseBboxLayout(''), []);
});
