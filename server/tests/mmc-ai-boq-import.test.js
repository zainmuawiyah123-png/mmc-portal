'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBoqFile, parseNumber, csvRows, normalizeRows } = require('../src/lib/mmc-ai/boq-import');

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

test('recognizes common Arabic BOQ heading variations and RTL marks', () => {
  const csv = '\u200fوصف الأعمال,وحدة القياس,إجمالي الكمية\nخرسانة,م3,١٢٫٥\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'arabic-variations.csv' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'خرسانة');
  assert.equal(result.items[0].unit, 'م3');
  assert.equal(result.items[0].quantity, 12.5);
});

test('normalizes Arabic and English BOQ units without losing the original label', () => {
  const { normalizeUnit } = require('../src/lib/mmc-ai/boq-import');
  for (const [raw, expected] of [['كغم','kg'],['كجم','kg'],['م3','m3'],['م³','m3'],['م²','m2'],['م2','m2'],['طن','ton'],['متر','m'],['متر طولي','m']]) {
    const result = normalizeUnit(raw);
    assert.equal(result.unit, expected, raw);
    assert.equal(result.known, true, raw);
    assert.equal(result.raw, raw, raw);
  }
  const unknown = normalizeUnit('صندوق');
  assert.equal(unknown.known, false);
  assert.equal(unknown.raw, 'صندوق');
  assert.equal(unknown.unit, 'صندوق');
});

test('Arabic unit normalization is exposed on imported rows while preserving source unit', () => {
  const csv = 'وصف البند,الوحدة,الكمية\nحديد تسليح,كغم,١٢٫٥\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'units.csv' });
  assert.equal(result.items[0].unit, 'كغم');
  assert.equal(result.items[0].unitNormalized, 'kg');
  assert.equal(result.items[0].unitKnown, true);
  assert.equal(result.items[0].quantity, 12.5);
});

// Regression coverage includes Arabic unit aliases merged from v15.

test('recognizes tender-style Arabic headers with reversed column order', () => {
  const csv = 'المبلغ,السعر,الكمية,وحدة,نوع العمل,الرقم\n12000,40,300,عدد,نقطة انارة داخلية,A1\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'tender-electrical.csv' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'نقطة انارة داخلية');
  assert.equal(result.items[0].unit, 'عدد');
  assert.equal(result.items[0].quantity, 300);
});

test('recognizes civil BOQ split header rows in XLSX worksheets', () => {
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>الرقم</t></is></c><c r="B1" t="inlineStr"><is><t>نوع العمل</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2" t="inlineStr"><is><t>أعمال الهدم والإزالة</t></is></c><c r="C2" t="inlineStr"><is><t>الوحدة</t></is></c><c r="D2" t="inlineStr"><is><t>الكمية</t></is></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>A1</t></is></c><c r="B3" t="inlineStr"><is><t>إزالة أبواب</t></is></c><c r="C3" t="inlineStr"><is><t>مقطوع</t></is></c><c r="D3"><v>1</v></c></row>' +
    '</sheetData></worksheet>';
  const buffer = makeStoredZip({'xl/worksheets/sheet1.xml': sheet});
  const result = parseBoqFile({ buffer, filename: 'tender-civil.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'إزالة أبواب');
  assert.equal(result.items[0].unit, 'مقطوع');
  assert.equal(result.items[0].quantity, 1);
});

test('imports a headerless mechanical BOQ row only when description, known unit and numeric quantity align', () => {
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="B1" t="inlineStr"><is><t>اعمال التكييف الميكانيكي</t></is></c></row>' +
    '<row r="2"><c r="B2" t="inlineStr"><is><t>تقديم وتركيب وحدات تكييف كاسيت</t></is></c><c r="C2" t="inlineStr"><is><t>عدد</t></is></c><c r="D2"><v>4</v></c><c r="E2"><v>3000</v></c><c r="F2"><v>12000</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>المجموع</t></is></c></row>' +
    '</sheetData></worksheet>';
  const buffer = makeStoredZip({'xl/worksheets/sheet1.xml': sheet});
  const result = parseBoqFile({ buffer, filename: 'mechanical.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'تقديم وتركيب وحدات تكييف كاسيت');
  assert.equal(result.items[0].unit, 'عدد');
  assert.equal(result.items[0].quantity, 4);
  assert.equal(result.items[0].rate, 3000);
  assert.equal(result.warnings[0].code, 'HEADERLESS_LAYOUT_INFERRED');
});

test('recognizes all unit labels present in the guesthouse BOQ workbook', () => {
  const { normalizeUnit } = require('../src/lib/mmc-ai/boq-import');
  const cases = [
    ['متر مربع','m2'], ['بالمتر المربع','m2'], ['متر طولي','m'], ['م.ط','m'],
    ['بالمتر الطولي','m'], ['بالعدد','nr'], ['عدد','nr'],
    ['مقطوع','ls'], ['متر مكعب','m3']
  ];
  for (const [raw, expected] of cases) {
    const actual = normalizeUnit(raw);
    assert.equal(actual.known, true, raw);
    assert.equal(actual.unit, expected, raw);
    assert.equal(actual.raw, raw, raw);
  }
});

test('recognizes Arabic civil tender split heading in an XLSX sheet', () => {
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>الرقم</t></is></c><c r="B1" t="inlineStr"><is><t>نوع العمل</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2" t="inlineStr"><is><t>أعمال الهدم والإزالة</t></is></c><c r="C2" t="inlineStr"><is><t>الوحدة</t></is></c><c r="D2" t="inlineStr"><is><t>الكميــة</t></is></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>A1</t></is></c><c r="B3" t="inlineStr"><is><t>هدم وقص السور</t></is></c><c r="C3" t="inlineStr"><is><t>مقطوع</t></is></c><c r="D3"><v>1</v></c></row>' +
    '</sheetData></worksheet>';
  const buffer = makeStoredZip({'xl/worksheets/sheet1.xml': sheet});
  const result = parseBoqFile({ buffer, filename: 'civil-split-header.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'هدم وقص السور');
  assert.equal(result.items[0].unit, 'مقطوع');
  assert.equal(result.items[0].quantity, 1);
});

test('imports electrical tender with description in E and quantity in C', () => {
  const csv = 'المبلــغ,السعـــر,الكميــة,وحدة,نــوع العمـــل,,الرقم\n8160,40,204,عدد,نقطة انارة داخلية حسب المخططات,,1\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'guesthouse-electrical.csv' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'نقطة انارة داخلية حسب المخططات');
  assert.equal(result.items[0].unit, 'عدد');
  assert.equal(result.items[0].quantity, 204);
  assert.equal(result.items[0].rate, 40);
});

test('merges a supplemental currency header row and preserves the civil unit rate', () => {
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>الرقم</t></is></c><c r="B1" t="inlineStr"><is><t>نوع العمل</t></is></c><c r="C1" t="inlineStr"><is><t>وحدة</t></is></c><c r="D1" t="inlineStr"><is><t>الكمية</t></is></c></row>' +
    '<row r="2"><c r="C2" t="inlineStr"><is><t>الكيل</t></is></c><c r="E2" t="inlineStr"><is><t>دينار</t></is></c><c r="F2" t="inlineStr"><is><t>دينار</t></is></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>A/1</t></is></c><c r="B3" t="inlineStr"><is><t>بند مدني تجريبي</t></is></c><c r="C3" t="inlineStr"><is><t>متر مربع</t></is></c><c r="D3"><v>12</v></c><c r="E3"><v>25</v></c><c r="F3"><v>300</v></c></row>' +
    '</sheetData></worksheet>';
  const buffer = makeStoredZip({'xl/worksheets/sheet1.xml': sheet});
  const result = parseBoqFile({ buffer, filename: 'civil-financial-header.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'بند مدني تجريبي');
  assert.equal(result.items[0].quantity, 12);
  assert.equal(result.items[0].rate, 25);
});

test('ignores currency-only and measurement-header rows instead of reporting them as invalid BOQ items', () => {
  const result = normalizeRows([
    ['Description','Unit','Quantity','Unit Rate'],
    ['', 'الكيل', '', 'دينار'],
    ['بند صحيح','متر مربع','2','10']
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].rate, 10);
  assert.equal(result.errors.length, 0);
});

test('imports headerless mechanical sheet only from validated description, unit and quantity columns', () => {
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="B1" t="inlineStr"><is><t>اعمال التكييف الميكانيكيه</t></is></c></row>' +
    '<row r="2"><c r="B2" t="inlineStr"><is><t>تقديم وتركيب وحدات تكيف كاسيت</t></is></c><c r="C2" t="inlineStr"><is><t>عدد</t></is></c><c r="D2"><v>4</v></c><c r="E2"><v>3000</v></c><c r="F2"><v>12000</v></c></row>' +
    '</sheetData></worksheet>';
  const buffer = makeStoredZip({'xl/worksheets/sheet1.xml': sheet});
  const result = parseBoqFile({ buffer, filename: 'mechanical-headerless.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'تقديم وتركيب وحدات تكيف كاسيت');
  assert.equal(result.items[0].unit, 'عدد');
  assert.equal(result.items[0].quantity, 4);
  assert.equal(result.items[0].rate, 3000);
});

test('skips discipline headings but retains incomplete referenced BOQ items for review', () => {
  const result = normalizeRows([
    ['Code','Description','Unit','Quantity'],
    ['A','Civil works','',''],
    ['A/1','Excavation','',''],
    ['A/2','Concrete','m3','10']
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'Concrete');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source.itemCode, 'A/1');
});


test('preserves workbook sheet names and original row numbers in parsed BOQ items', () => {
  const sheet = '<worksheet><sheetData>' +
    '<row r="7"><c r="A7" t="inlineStr"><is><t>الرقم</t></is></c><c r="B7" t="inlineStr"><is><t>نوع العمل</t></is></c><c r="C7" t="inlineStr"><is><t>وحدة</t></is></c><c r="D7" t="inlineStr"><is><t>الكمية</t></is></c></row>' +
    '<row r="8"><c r="C8" t="inlineStr"><is><t>الكيل</t></is></c><c r="E8" t="inlineStr"><is><t>دينار</t></is></c><c r="F8" t="inlineStr"><is><t>دينار</t></is></c></row>' +
    '<row r="19"><c r="A19" t="inlineStr"><is><t>A/1</t></is></c><c r="B19" t="inlineStr"><is><t>بند مدني تجريبي</t></is></c><c r="C19" t="inlineStr"><is><t>متر مربع</t></is></c><c r="D19"><v>12</v></c><c r="E19"><v>25</v></c><c r="F19"><v>300</v></c></row>' +
    '</sheetData></worksheet>';
  const buffer = makeStoredZip({
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="الأعمال المدنية" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet
  });
  const result = parseBoqFile({ buffer, filename: 'source-provenance.xlsx' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sourceSheet, 'الأعمال المدنية');
  assert.equal(result.items[0].rowNumber, 19);
  assert.equal(result.items[0].sourceAmount, 300);
  assert.deepEqual(result.sourceSheets, ['الأعمال المدنية']);
});

test('flags a description that says linear metres while the table unit is square metres', () => {
  const csv = 'الرقم,نوع العمل,وحدة,الكمية,السعر,المبلغ\nK,توريد بازلت كمية الجبه بالمتر الطولي قريبا 53 متر,متر مربع,45,25,1125\n';
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'unit-conflict.csv' });
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].validationIssues.some(x => x.includes('الوصف يشير إلى متر طولي')));
  assert.equal(result.items[0].quantity, 45);
  assert.equal(result.items[0].unit, 'متر مربع');
});


test('recognizes the Arabic Jordanian BOQ header and preserves sections and explicit zero rates', () => {
  const result = normalizeRows([
    ['رقم','وصف الأعمال والمواصفات','الوحدة','الكمية','سعر الوحدة (د.أ)','الإجمالي (د.أ)'],
    ['', 'أولاً: الأعمال الترابية وتجهيز الموقع', '', '', '', ''],
    ['1','تسوية الأرض الطبيعية','م²','24','10','240'],
    ['2','إعادة الطمم حول الأعمال الإنشائية','م³','15','0','0'],
    ['', 'ثانياً: الخرسانة المسلحة والأعمال الإنشائية', '', '', '', ''],
    ['5','خرسانة مسلحة C25','م³','2.4','200','480']
  ]);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].sectionLabel, 'أولاً: الأعمال الترابية وتجهيز الموقع');
  assert.equal(result.items[1].rate, 0);
  assert.equal(result.items[1].sourceAmount, 0);
  assert.equal(result.items[2].sectionLabel, 'ثانياً: الخرسانة المسلحة والأعمال الإنشائية');
  assert.equal(result.items[2].rowNumber, 6);
  assert.equal(result.errors.length, 0);
});


test('preserves repeated source BOQ rows and reports them as review duplicates', () => {
  const csv = `Item Code,Description,Unit,Quantity,Unit Rate\n1,Concrete,m3,10,20\n2,Concrete,m3,10,20\n`;
  const result = parseBoqFile({ buffer: Buffer.from(csv), filename: 'repeated-lines.csv' });
  assert.equal(result.items.length, 2);
  assert.equal(result.summary.validItems, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.items[1].itemCode, '2');
  assert.equal(result.items[1].duplicateOfRowNumber, 2);
});

test('imports the uploaded Damkhi-Qatrane Arabic BOQ with all 58 source items and 12 sections', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'damkhi-qatrane-boq.csv'));
  const result = parseBoqFile({ buffer, filename: 'damkhi-qatrane-boq.csv' });
  assert.equal(result.items.length, 58);
  assert.equal(result.summary.validItems, 58);
  assert.equal(result.errors.length, 0);
  assert.equal(new Set(result.items.map(item => item.sectionLabel)).size, 12);
  assert.equal(result.items.some(item => item.itemCode === '15'), false);
  assert.equal(result.items.find(item => item.itemCode === '25').unitNormalized, 'm');
  assert.equal(result.items.find(item => item.itemCode === '25').unitKnown, true);
  const pricedTotal = result.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  assert.equal(Number(pricedTotal.toFixed(3)), 18235.4);
  const sourceTotal = result.items.reduce((sum, item) => sum + item.sourceAmount, 0);
  assert.equal(Number(sourceTotal.toFixed(3)), 18235.4);
});

test('reads all uploaded Damkhi-Qatrane BOQ rows through the XLSX worksheet reader', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const matrix = csvRows(fs.readFileSync(path.join(__dirname, 'fixtures', 'damkhi-qatrane-boq.csv'), 'utf8'));
  const colName = index => {
    let n = index + 1, name = '';
    while (n) { const rem = (n - 1) % 26; name = String.fromCharCode(65 + rem) + name; n = Math.floor((n - 1) / 26); }
    return name;
  };
  const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const rowsXml = matrix.map((row, r) => {
    const cells = row.map((value, col) => {
      if (value === '') return '';
      const ref = colName(col) + (r + 1);
      return /^-?\d+(?:\.\d+)?$/.test(String(value))
        ? '<c r="' + ref + '"><v>' + value + '</v></c>'
        : '<c r="' + ref + '" t="inlineStr"><is><t>' + escapeXml(value) + '</t></is></c>';
    }).join('');
    return '<row r="' + (r + 1) + '">' + cells + '</row>';
  }).join('');
  const sheet = '<worksheet><sheetData>' + rowsXml + '</sheetData></worksheet>';
  const buffer = makeStoredZip({
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="جدول الكميات" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet
  });
  const result = parseBoqFile({ buffer, filename: 'damkhi-qatrane-boq.xlsx' });
  assert.equal(result.items.length, 58);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sourceSheets[0], 'جدول الكميات');
  assert.equal(result.items.find(item => item.itemCode === '25').unitNormalized, 'm');
  assert.equal(Number(result.items.reduce((sum, item) => sum + item.quantity * item.rate, 0).toFixed(3)), 18235.4);
});
