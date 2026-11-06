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

test('Regional official tender source links include Bahrain and Iraq with correct integration caveat', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'), 'utf8');
  assert.ok(page.includes('https://www.tenderboard.gov.bh/Ar/Tenders/PublicTenders/'));
  assert.ok(page.includes('https://www.itp.iq/'));
  assert.match(page, /لن نستورد أو نعيد نشر بياناتها آلياً دون تصريح/);
});

test('Regional official procurement links include Qatar, Oman and UAE without claiming live sync', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'), 'utf8');
  assert.ok(page.includes('https://monaqasat.mof.gov.qa/TendersOnlineServices'));
  assert.ok(page.includes('https://etendering.tenderboard.gov.om/'));
  assert.ok(page.includes('https://mof.gov.ae/en/public-finance/government-procurement/digital-procurement-platform/'));
  assert.match(page, /لم يُعتمد موصل آلي بعد/);
});

test('Kuwait official CAPT portal is listed as a source without claiming automated import', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'), 'utf8');
  assert.ok(page.includes('https://capt.gov.kw/en/'));
  assert.match(page, /ولا ندّعي وجود مزامنة آلية/);
});

const { parseApcDetail } = require('../src/lib/apc-sync');
test('APC detail parser extracts tender fields and only permits official Arab Potash document links', () => {
  const html = '<div>Tender title and number: IFB NO. 202602574/NA - Construction of Army Towers Purchase Date: 09/11/2026 Closing date: 29/11/2026 Copy Price: JOD 232 Bid Bond Value: JOD 17,500 Vendor Qualifications: Grade 3 Remarks: Civil works</div>'
    + '<a href="https://arabpotash.com/docs/tender.pdf">Tender Documents</a>'
    + '<a href="https://evil.example/file.pdf">Announcement</a>';
  const d = parseApcDetail(html,'2310',{title:'fallback'});
  assert.match(d.title,/Construction of Army Towers/);
  assert.equal(d.purchaseDate,'2026-11-09');
  assert.equal(d.closingDate,'2026-11-29');
  assert.match(d.bidBond,/17,500/);
  assert.equal(d.documents.length,1);
  assert.equal(new URL(d.documents[0].url).hostname,'arabpotash.com');
});
test('APC detail endpoint is authenticated for contractors and MMC admins and reads stored details/documents', () => {
  const fs=require('node:fs'),path=require('node:path');
  const route=fs.readFileSync(path.join(__dirname,'../src/routes/opportunities.js'),'utf8');
  const migration=fs.readFileSync(path.join(__dirname,'../src/migrate.js'),'utf8');
  const page=fs.readFileSync(path.join(__dirname,'../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'),'utf8');
  assert.match(route,/router\.get\('\/:id', directoryReaders/);
  assert.match(route,/tender_opportunity_public_documents/);
  assert.match(migration,/upgradeTenderOpportunityDetails/);
  assert.match(page,/تفاصيل العطاء والوثائق داخل MMC/);
  assert.match(page,/api\/opportunities\//);
});

const {SOURCES,parseSource}=require('../src/lib/jordan-public-sources-sync');
test('Jordan official tender connector registry includes GAM, phosphate, electricity, refinery and NGO sources',()=>{
 const keys=SOURCES.map(x=>x.key);
 for(const key of ['gam','jpmc','nepco','jepco','sepco','jprc','jppmc','jordan_bromine','memr','mwi','emrc','unicef_jo'])assert.ok(keys.includes(key),key);
});
test('Jordan public-source parser extracts tender metadata and rejects off-domain document links',()=>{
 const source=SOURCES.find(x=>x.key==='nepco');
 const html='<table><tr><td>عطاء رقم: 79/2026</td><td><a href="/TenderPage.aspx?id=79">الاعمال المدنية لانشاء مركز المراقبة والتحكم البديل</a></td><td>تاريخ الإغلاق: 2026-11-18</td></tr></table>';
 const rows=parseSource(html,source,'2026-11-06');
 assert.equal(rows.length,1);
 assert.equal(rows[0].authority,'شركة الكهرباء الوطنية');
 assert.match(rows[0].tenderNumber,/79\/2026/);
 assert.equal(rows[0].closingAt,'2026-11-18');
 assert.equal(new URL(rows[0].sourceUrl).hostname,'www.nepco.com.jo');
});
test('Jordan source sync endpoint is MMC-admin only and visible in admin page',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const route=fs.readFileSync(path.join(__dirname,'../src/routes/opportunities.js'),'utf8');
 const page=fs.readFileSync(path.join(__dirname,'../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html'),'utf8');
 assert.match(route,/router\.post\('\/admin\/sync\/jordan-official'/);
 assert.match(route,/syncJordanPublicSources/);
 assert.match(page,/oa-sync-jordan-official/);
 assert.match(page,/الفوسفات/);
 assert.match(page,/مصفاة البترول/);
});
