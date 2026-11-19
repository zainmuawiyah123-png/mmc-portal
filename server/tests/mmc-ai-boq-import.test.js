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
  const csv = 'Project Bill of Quantities\n\nDescription;Unit;Quantity\nConcrete;m3;12.5\n';
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


function makeStoredZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries ? Object.keys(entries).length : 0, 8);
  end.writeUInt16LE(entries ? Object.keys(entries).length : 0, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('reads an XLSX workbook and selects the worksheet containing Arabic BOQ headers', () => {
  const shared = '<sst><si><t>ملاحظات</t></si><si><t>الوصف</t></si><si><t>الوحدة</t></si><si><t>الكمية</t></si><si><t>خرسانة مسلحة</t></si></sst>';
  const notes = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Cover sheet</t></is></c></row></sheetData></worksheet>';
  const boq = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="inlineStr"><is><t>m3</t></is></c><c r="C2"><v>125.5</v></c></row></sheetData></worksheet>';
  const buffer = makeStoredZip({
    'xl/sharedStrings.xml': shared,
    'xl/worksheets/sheet1.xml': notes,
    'xl/worksheets/sheet2.xml': boq
  });
  const result = parseBoqFile({ buffer, filename: 'realistic-boq.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'خرسانة مسلحة');
  assert.equal(result.items[0].unit, 'm3');
  assert.equal(result.items[0].quantity, 125.5);
});
