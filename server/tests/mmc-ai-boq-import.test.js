'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBoqFile, parseNumber, csvRows } = require('../src/lib/mmc-ai/boq-import');

test('imports English CSV headings and decimal quantities', () => {
  const csv = 'Description,Unit,Quantity,Unit Rate\nConcrete,m3,12.75,85.5\nRebar,kg,1000,0.92\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'boq.csv' });
  assert.equal(result.summary.validItems, 2);
  assert.equal(result.items[0].quantity, 12.75);
  assert.equal(result.items[0].rate, 85.5);
});

test('imports Arabic headings and Arabic-Indic numerals', () => {
  const csv = 'وصف البند,الوحدة,الكمية\nخرسانة,m3,١٢٫٥\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'boq.csv' });
  assert.equal(result.items[0].description, 'خرسانة');
  assert.equal(result.items[0].quantity, 12.5);
});

test('keeps invalid rows visible as errors instead of silently dropping them', () => {
  const csv = 'Description,Unit,Quantity\nValid item,m3,10\nMissing quantity,m2,\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'boq.csv' });
  assert.equal(result.items.length, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].issues.includes('الكمية غير صالحة أو مفقودة'));
});

test('supports quoted commas and semicolon-delimited CSV', () => {
  const rows = csvRows('"Description";Unit;Quantity\n"Concrete, grade 40";m3;2.5');
  assert.equal(rows[1][0], 'Concrete, grade 40');
  assert.equal(rows[1][2], '2.5');
});

test('detects CSV delimiter when a title row appears before the headings', () => {
  const csv = 'Project Bill of Quantities\\n\\nDescription;Unit;Quantity\\nConcrete;m3;12.5\\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'boq.csv' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'Concrete');
  assert.equal(result.items[0].quantity, 12.5);
});

test('normalizes decimal separators and rejects ambiguous text', () => {
  assert.equal(parseNumber('1,25'), 1.25);
  assert.equal(parseNumber('١٢٫٥'), 12.5);
  assert.ok(Number.isNaN(parseNumber('about 12')));
});

test('does not guess missing quantity or accept negative quantity', () => {
  const csv = 'Description,Unit,Quantity\nNo quantity,m,\nNegative,m,-3\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'boq.csv' });
  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length, 2);
});

test('rejects unsupported formats with an explicit message', () => {
  assert.throws(() => parseBoqFile({ buffer: Buffer.from('x'), filename: 'boq.xls' }), /XLSX وCSV/);
});
