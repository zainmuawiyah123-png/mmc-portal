'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJonepsRows, extractPageUrls, LIST_URL } = require('../src/lib/joneps-sync');
const { normalizeWorldBankNotice } = require('../src/lib/opportunity-sync');
const { normalizeUNGMNotice } = require('../src/lib/ungm-sync');

test('JONEPS parser maps an official tender row and keeps its source on the JONEPS domain', () => {
  const html = '<table><tr><td>2026-001</td><td><a href="/ep/invt/viewTender.do?id=2026-001">أعمال طرق</a></td><td>وزارة الأشغال</td><td>أشغال</td><td>01/11/2026</td><td>31/12/2099</td></tr></table>';
  const [row] = parseJonepsRows(html);
  assert.ok(row);
  assert.equal(row.id, '2026-001');
  assert.equal(row.title, 'أعمال طرق');
  assert.equal(row.authority, 'وزارة الأشغال');
  assert.equal(row.country, 'JO');
  assert.equal(row.publishedAt, '2026-11-01');
  assert.equal(row.closingAt, '2099-12-31');
  assert.equal(row.status, 'open');
  assert.equal(new URL(row.sourceUrl).origin, 'https://www.joneps.gov.jo');
});

test('JONEPS parser rejects impossible calendar dates instead of importing them', () => {
  const html = '<table><tr><td>2026-002</td><td>توريد معدات</td><td>جهة حكومية</td><td>توريد</td><td>31/02/2026</td><td>31/02/2099</td></tr></table>';
  const [row] = parseJonepsRows(html);
  assert.ok(row);
  assert.equal(row.publishedAt, null);
  assert.equal(row.closingAt, null);
});

test('JONEPS pagination accepts only same-origin list pages and always includes page one', () => {
  const html = '<a href="/ep/invt/selectListTendInvitAL.do?page=2">2</a><a href="https://evil.example/ep/invt/selectListTendInvitAL.do?page=3">3</a><a href="https://www.joneps.gov.jo/ep/invt/other.do">4</a>';
  const urls = extractPageUrls(html, 10);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], LIST_URL);
  assert.equal(new URL(urls[1]).origin, 'https://www.joneps.gov.jo');
  assert.equal(new URL(urls[1]).pathname, '/ep/invt/selectListTendInvitAL.do');
});

test('World Bank normalizer maps Jordan and builds a safe official fallback URL', () => {
  const row = normalizeWorldBankNotice({
    id: 'WB/2026/001',
    bid_description: 'Road rehabilitation works',
    country_name: 'Jordan',
    deadline_date: '2099-12-31',
    notice_type: 'Request for Bids'
  });
  assert.equal(row.country, 'JO');
  assert.equal(row.title, 'Road rehabilitation works');
  assert.equal(row.status, 'open');
  assert.match(row.sourceUrl, /^https:\/\/projects\.worldbank\.org\//);
  assert.match(row.sourceUrl, /WB%2F2026%2F001/);
});

test('World Bank normalizer ignores records without a stable id or title', () => {
  assert.equal(normalizeWorldBankNotice({ id: 'WB-2' }), null);
  assert.equal(normalizeWorldBankNotice({ title: 'No ID' }), null);
});

test('UNGM normalizer imports finalized notices and maps Jordan country codes', () => {
  const row = normalizeUNGMNotice({
    Id: 'UN-2026-001',
    Title: 'Supply and installation',
    Status: 'Finalized',
    CountryISO3Codes: ['JOR'],
    Deadline: '2099-12-31',
    DatePublished: '2026-11-01',
    Reference: 'UNGM-REF-001',
    Description: 'Official procurement notice'
  });
  assert.equal(row.country, 'JO');
  assert.equal(row.tenderNumber, 'UNGM-REF-001');
  assert.equal(row.status, 'open');
  assert.equal(row.title, 'Supply and installation');
});

test('UNGM normalizer never imports draft or non-finalized notices', () => {
  assert.equal(normalizeUNGMNotice({ Id: 'UN-2', Title: 'Draft', Status: 'Draft' }), null);
});

const { parseApcRows } = require('../src/lib/apc-sync');
test('APC parser reads the public list row, dates, bond, qualifications and keeps the link on arabpotash.com', () => {
  const html = '<div><a href="https://arabpotash.com/En/TendersDetails?PID=2310">IFB NO. 202602574/NA - Construction of Army Towers / South Expansion Requirements Purchase Date: 09/11/2026 Closing date: 29/11/2026 Copy Price: JOD 232 Bid Bond Value: JOD 17,500 Vendor Qualifications: المقاولين المحليين درجة ثالثة Remarks: Construction of Army Towers Read More</a>'
    + '<a href="/En/TendersDetails?PID=2302">IFB No. 202603358/AS - Supply 400 Panels Purchase Date: 13/10/2026 Closing date: 26/10/2026 Copy Price: JOD 116.00 Bid Bond Value: JOD 7,000.00 Vendor Qualifications: الشركات ذات الإختصاص Remarks: x Read More</a></div>';
  const rows = parseApcRows(html, '2026-11-05');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '2310');
  assert.equal(rows[0].tenderNumber, '202602574/NA');
  assert.equal(rows[0].title, 'IFB NO. 202602574/NA - Construction of Army Towers / South Expansion Requirements');
  assert.equal(rows[0].publishedAt, '2026-11-09');
  assert.equal(rows[0].closingAt, '2026-11-29');
  assert.equal(rows[0].status, 'open');
  assert.match(rows[0].summary, /JOD 17,500/);
  assert.equal(rows[1].status, 'closed');
  assert.equal(new URL(rows[1].sourceUrl).origin, 'https://arabpotash.com');
});

const { parseJpmcRows } = require('../src/lib/jpmc-sync');
test('JPMC parser imports official Arabic tender headings, dates and same-origin details links', () => {
  const html = '<section><div>تاريخ بدء العطاء: 01-11-2026 تاريخ انتهاء العطاء: 12-11-2026</div>'
    + '<h3>علان تمديد طرح العطاء رقم (T2026/35 SH) "مشروع إعادة تأهيل هنجر المستودعات الرئيسة في منجم الشيدية"</h3>'
    + '<a href="/ar/tender/12345">اقرأ المزيد</a></section>'
    + '<section><div>تاريخ بدء العطاء: 01-11-2026 تاريخ انتهاء العطاء: 05-11-2026</div>'
    + '<h3>اعلان طرح العطاء رقم (T2026/41 F) التفتيش والمعاينة للشحنات المصدرة والمستوردة بحراً</h3>'
    + '<a href="https://evil.example/steal">اقرأ المزيد</a></section>';
  const rows = parseJpmcRows(html, '2026-11-06');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tenderNumber, 'T2026/35 SH');
  assert.equal(rows[0].closingAt, '2026-11-12');
  assert.equal(rows[0].status, 'open');
  assert.equal(new URL(rows[0].sourceUrl).origin, 'https://www.jpmc.com.jo');
  assert.equal(rows[1].closingAt, '2026-11-05');
  assert.equal(rows[1].status, 'closed');
  assert.equal(new URL(rows[1].sourceUrl).origin, 'https://www.jpmc.com.jo');
});

const { parseJprcRows } = require('../src/lib/jprc-sync');
test('JPRC parser extracts tender metadata from official notice cards', () => {
  const html = '<a href="/ar/modules/tenders/158"><span>رقم العطاء: 158/2026 موضوع العطاء: مناقصة اشغال 158-2026 اعمال مدنية متفرقة في دائرة مستودعات العقبة تاريخ طرح العطاء: 2026/10/29 تاريخ الاغلاق: 2026/11/12 سعر النسخة: مجاناً</span></a>';
  const [row] = parseJprcRows(html, '2026-11-06');
  assert.ok(row);
  assert.equal(row.tenderNumber, '158/2026');
  assert.equal(row.closingAt, '2026-11-12');
  assert.equal(row.status, 'open');
  assert.equal(new URL(row.sourceUrl).origin, 'https://jopetrol.com.jo');
});

const { parseJepcoRows } = require('../src/lib/jepco-sync');
test('JEPCO parser extracts tender number, specification and submission deadline from official table', () => {
  const html = '<table><tr><th>رقم العطاء</th><th>التفصيل</th><th>ثمن النسخة</th><th>موعد التسليم</th></tr>'
    + '<tr><td>42/2026</td><td>12 &amp; 36 KV O.H.L DROP OUT FUSED ISOLATORS</td><td>15</td><td>12/11/2026</td></tr></table>';
  const [row] = parseJepcoRows(html, '2026-11-06');
  assert.ok(row);
  assert.equal(row.tenderNumber, '42/2026');
  assert.equal(row.closingAt, '2026-11-12');
  assert.equal(row.status, 'open');
  assert.equal(row.country, 'JO');
});
