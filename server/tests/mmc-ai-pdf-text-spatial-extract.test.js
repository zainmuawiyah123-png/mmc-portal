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


test('reads rotated SVG page viewBox as the spatial text alignment frame', () => {
  const { parseSvgPageFrame } = require('../src/lib/mmc-ai/pdf-text-spatial-extract');
  const frame = parseSvgPageFrame('<svg width="2384pt" height="1684pt" viewBox="0 0 2384 1684">');
  assert.deepEqual(frame.viewBox, [0, 0, 2384, 1684]);
  assert.equal(frame.width, 2384);
  assert.equal(frame.height, 1684);
  assert.equal(frame.physicalWidth, 2384);
  assert.equal(frame.physicalHeight, 1684);
});

test('parses numeric attributes using real word boundaries', () => {
  const xml = '<doc><page width="612" height="792"><flow><block><line><word xMin="10" yMin="20" xMax="30" yMax="40">DIM</word></line></block></flow></page></doc>';
  const pages = parseBboxLayout(xml);
  assert.equal(pages[0].words[0].box.xMin, 10);
  assert.equal(pages[0].words[0].box.yMax, 40);
});

test('rotates Poppler bbox coordinates into SVG frame for 270 degree PDF pages',()=>{
 const result=rotateBboxToSvgFrame({xMin:100,yMin:200,xMax:140,yMax:240},1684,2384,270);
 assert.deepEqual(result,{xMin:200,yMin:1544,xMax:240,yMax:1584});
});
test('rotates Poppler bbox coordinates into SVG frame for 90 degree PDF pages',()=>{
 const result=rotateBboxToSvgFrame({xMin:100,yMin:200,xMax:140,yMax:240},1684,2384,90);
 assert.deepEqual(result,{xMin:2144,yMin:100,xMax:2184,yMax:140});
});
test('does not transform unsupported page rotations',()=>{
 assert.equal(rotateBboxToSvgFrame({xMin:1,yMin:2,xMax:3,yMax:4},100,200,45),null);
});
