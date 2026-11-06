'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJonepsRows, extractPageUrls, parseJonepsDetail, mapLimit, LIST_URL } = require('../src/lib/joneps-sync');
const { normalizeWorldBankNotice } = require('../src/lib/opportunity-sync');
const { normalizeUNGMNotice } = require('../src/lib/ungm-sync');
const { parseDetail, dateISO, extractTenderNumber } = require('../src/lib/apc-sync');

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

test('World Bank normalizer maps ISO-3 country codes for all Arab countries', () => {
  const samples = { SAU:'SA', ARE:'AE', IRQ:'IQ', KWT:'KW', QAT:'QA', BHR:'BH', OMN:'OM',
    EGY:'EG', LBN:'LB', PSE:'PS', SYR:'SY', YEM:'YE', LBY:'LY', DZA:'DZ', MAR:'MA',
    TUN:'TN', SDN:'SD', MRT:'MR', SOM:'SO', DJI:'DJ', COM:'KM' };
  for (const [iso3, iso2] of Object.entries(samples)) {
    const row = normalizeWorldBankNotice({id:'WB-'+iso3,title:'Public works notice',country_code:iso3});
    assert.equal(row.country, iso2, iso3+' should map to '+iso2);
  }
});

test('World Bank normalizer falls back to Arab country names when no ISO code is supplied', () => {
  assert.equal(normalizeWorldBankNotice({id:'WB-IQ',title:'Road works',country_name:'Iraq'}).country,'IQ');
  assert.equal(normalizeWorldBankNotice({id:'WB-QA',title:'Civil works',country_name:'Qatar'}).country,'QA');
  assert.equal(normalizeWorldBankNotice({id:'WB-MA',title:'Water works',country_name:'Morocco'}).country,'MA');
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

test('APC parser extracts public tender details, dates, bond, fees and same-host documents', () => {
  const html = '<html><body><h1>Tender title and number: Civil works package APC-2026-01</h1><div>Purchase Date: 01/11/2026</div><div>Closing date: 20/11/2099</div><div>Copy Price: 50 JOD</div><div>Bid Bond Value: 5%</div><div>Vendor Qualifications: Class 1 civil contractor</div><div>Remarks: Site visit required</div><a href="/files/tender.pdf">Tender Documents</a><a href="https://evil.example/steal.pdf">Announcement</a></body></html>';
  const row = parseDetail(html, '98765');
  assert.equal(row.title, 'Civil works package APC-2026-01');
  assert.equal(row.purchase, '01/11/2026');
  assert.equal(row.closing, '20/11/2099');
  assert.equal(row.fee, '50 JOD');
  assert.equal(row.bond, '5%');
  assert.equal(row.qual, 'Class 1 civil contractor');
  assert.equal(row.docs.length, 1);
  assert.equal(new URL(row.docs[0].url).hostname, 'www.arabpotash.com');
});


test('APC detail parser deduplicates repeated public document URLs', () => {
  const url = 'https://www.arabpotash.com/En/TendersDetails?PID=2279';
  const html = '<h1>Tender title and number: Prequalification Earthworks</h1>' +
    '<a href="/files/boq.pdf">Tender Documents</a>' +
    '<a href="https://www.arabpotash.com/files/boq.pdf">Announcement Documents</a>';
  const row = parseDetail(html, '2279');
  assert.equal(row.docs.length, 1);
  assert.equal(row.docs[0].url, 'https://www.arabpotash.com/files/boq.pdf');
});

test('APC tender number extraction captures the full reference and rejects stray single letters', () => {
  assert.equal(extractTenderNumber('IFB No. 202603638/ZM - Soil Replacement and Landscaping'), '202603638/ZM');
  assert.equal(extractTenderNumber('IFB. No: 202603541/ZM - Supply and Install Canopy'), '202603541/ZM');
  assert.equal(extractTenderNumber('Prequalification for civil works package'), null);
});

test('APC date parser rejects impossible dates', () => {
  assert.equal(dateISO('31/02/2027'), null);
  assert.equal(dateISO('20/11/2099'), '2099-11-20');
});

test('JONEPS detail parser extracts public tender dates and fees and filters document hosts', () => {
  const url = 'https://www.joneps.gov.jo/ep/invt/viewTender.do?id=2026-001';
  const html = '<html><body><div>تاريخ شراء الوثائق: 01/11/2026</div><div>آخر موعد لتقديم العروض: 20/12/2099</div><div>ثمن نسخة العطاء: 25 دينار كفالة دخول العطاء: 5% تصنيف المقاول: أول أشغال ملاحظات: زيارة موقع</div><a href="/docs/boq.pdf">جدول الكميات</a><a href="https://evil.example/secret.pdf">تحميل المخططات</a></body></html>';
  const detail = parseJonepsDetail(html, url);
  assert.equal(detail.purchase, '01/11/2026');
  assert.equal(detail.closing, '20/12/2099');
  assert.equal(detail.fee, '25 دينار');
  assert.equal(detail.bond, '5%');
  assert.equal(detail.qualification, 'أول أشغال');
  assert.equal(detail.remarks, 'زيارة موقع');
  assert.equal(detail.docs.length, 1);
  assert.equal(new URL(detail.docs[0].url).hostname, 'www.joneps.gov.jo');
  assert.equal(detail.verified, true);
});

test('JONEPS detail parser does not trust non-HTTPS or external document URLs', () => {
  const detail = parseJonepsDetail('<a href="http://www.joneps.gov.jo/files/a.pdf">Download</a><a href="https://evil.example/a.pdf">Documents</a>', 'https://www.joneps.gov.jo/ep/invt/viewTender.do?id=1');
  assert.equal(detail.docs.length, 0);
});

test('APC detail parser indexes official public SharePoint document links without accepting unrelated hosts', () => {
  const html = '<h1>Tender title and number: Prequalification Earthworks</h1><div>Purchase Date: 01/11/2026</div><div>Closing date: 20/11/2099</div><a href="https://arabpotash-my.sharepoint.com/:b:/p/public/abc?e=123">Prequalification Documents</a><a href="https://evil.example/file.pdf">Tender Documents</a>';
  const row = parseDetail(html, '2279');
  assert.equal(row.docs.length, 1);
  assert.equal(new URL(row.docs[0].url).hostname, 'arabpotash-my.sharepoint.com');
});


test('APC detail parser indexes file-extension links even when link text is generic', () => {
  const html = '<h1>Tender title and number: Civil works package APC-2026-02</h1>' +
    '<a href="/files/boq.pdf?download=1">Open</a>' +
    '<a href="https://evil.example/private.pdf">Open</a>';
  const row = parseDetail(html, '2280');
  assert.equal(row.docs.length, 1);
  assert.equal(row.docs[0].url, 'https://www.arabpotash.com/files/boq.pdf?download=1');
});

test('JONEPS mapLimit runs bounded tasks and preserves result order', async () => {
  let active = 0, maximum = 0;
  const results = await mapLimit([3, 1, 2, 4], 2, async value => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, value === 3 ? 8 : 2));
    active--; return value * 2;
  });
  assert.deepEqual(results, [6, 2, 4, 8]);
  assert.equal(maximum, 2);
});

test('Jordan corporate and municipality source parsers normalize public notices', () => {
 const { parseGAMRows } = require('../src/lib/gam-sync');
 const { parseJpmcRows } = require('../src/lib/jpmc-sync');
 const { parseJprcRows } = require('../src/lib/jprc-sync');
 const { parseJepcoRows } = require('../src/lib/jepco-sync');
 const gam=parseGAMRows('<table><tr><th>رقم المناقصة</th><th>اسم المناقصة</th><th>كفالة</th><th>آخر موعد للبيع</th><th>آخر موعد للاستفسارات</th><th>آخر موعد لإيداع العروض</th></tr><tr><td>74/1/2026</td><td>إعادة تأهيل أدراج</td><td>13000 دينار</td><td>250 دينار</td><td>تصنيف أشغال</td><td>11/11/2026</td><td>17/11/2026</td><td>23/11/2026</td></tr></table>','2026-11-06');
 assert.equal(gam[0].tenderNumber,'74/1/2026');
 assert.equal(gam[0].closingAt,'2026-11-23');
 const jpmc=parseJpmcRows('<a href="/ar/tender/123">عطاء أعمال مدنية 01/12/2026</a>','2026-11-06');
 assert.ok(Array.isArray(jpmc));
 const jprc=parseJprcRows('<a href="/ar/tender/123">مناقصة صيانة 01/12/2026</a>','2026-11-06');
 assert.ok(Array.isArray(jprc));
 const jepco=parseJepcoRows('<table><tr><td>مناقصة تمديدات</td><td>01/12/2026</td></tr></table>','2026-11-06');
 assert.ok(Array.isArray(jepco));
});
