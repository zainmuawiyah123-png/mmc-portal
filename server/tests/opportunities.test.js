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


test('External directory listing and unified feed are readable by MMC admins and contractors only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(route.includes("A.requireRole('contractor', 'admin')"));
  assert.match(route, /router\.get\('\/', directoryReaders,/);
  assert.match(route, /router\.get\('\/feed', directoryReaders,/);
  assert.match(route, /router\.use\(A\.requireAuth, A\.requireRole\('admin'\)\)/);
});


test('Optional UNGM credentials do not turn successful connector runs into a failed sync cycle', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const scheduler = fs.readFileSync(path.join(__dirname, '../src/lib/scheduler.js'), 'utf8');
  assert.match(scheduler, /filter\(\(\[,v\]\)=>!v\.ok&&!v\.skipped\)/);
});

test('MMC admin can trigger all configured source connectors and APC independently', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'), 'utf8');
  assert.match(route, /router\.post\('\/admin\/sync\/all'/);
  assert.match(route, /runOpportunitySyncJob\(\)/);
  assert.match(route, /router\.post\('\/admin\/sync\/apc'/);
  assert.match(page, /oa-sync-all/);
  assert.match(page, /oa-sync-apc/);
});

test('External directory API exposes per-source and open/closed diagnostic counts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'), 'utf8');
  assert.match(route, /sourceCounts/);
  assert.match(route, /allCounts/);
  assert.match(page, /إجمالي السجلات/);
  assert.match(page, /sourceNames/);
});
