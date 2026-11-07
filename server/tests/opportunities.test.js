'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-opportunities-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.JWT_SECRET = 'opportunity-test-secret-not-production';
const { migrate } = require('../src/migrate');
const { getDB, closeDB } = require('../src/db');
migrate(process.env.DB_PATH);

const { parseJonepsRows, extractPageUrls, LIST_URL } = require('../src/lib/joneps-sync');
const { normalizeWorldBankNotice } = require('../src/lib/opportunity-sync');
const { normalizeUNGMNotice, isDeadlineExpired } = require('../src/lib/ungm-sync');

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
  assert.equal(normalizeUNGMNotice({ Id: 'UN-SA-1', Title: 'Saudi notice', Status: 'Finalized', CountryISO3Codes: ['SAU'], Deadline: '2099-12-31' }).country, 'SA');
});

test('UNGM normalizer never imports draft or non-finalized notices', () => {
  assert.equal(normalizeUNGMNotice({ Id: 'UN-2', Title: 'Draft', Status: 'Draft' }), null);
});

test('UNGM timestamp deadline expires at the stated instant, including on the same date', () => {
  const before = Date.parse('2026-11-07T20:58:00Z'); // 23:58 in Amman
  const after = Date.parse('2026-11-07T21:00:00Z'); // 00:00 in Amman on 8 November
  assert.equal(isDeadlineExpired('2026-11-07T23:59:00+03:00', before), false);
  assert.equal(isDeadlineExpired('2026-11-07T23:59:00+03:00', after), true);
  assert.equal(isDeadlineExpired('2026-11-07', before), false, 'date-only source data remains open through its date');
});

const { parseApcRows, parseApcDetail } = require('../src/lib/apc-sync');
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

test('APC detail parser extracts public attachments only from the official Arab Potash domain', () => {
  const html = '<p>Purchase Date: 09/11/2026 Closing date: 29/11/2026 Copy Price: JOD 232 Bid Bond Value: JOD 17,500 Vendor Qualifications: Contractors</p>'
    + '<a href="/documents/202602574.pdf">Download tender document</a>'
    + '<a href="https://evil.example/tender.pdf">Download mirror</a>';
  const result = parseApcDetail(html, 'https://arabpotash.com/En/TendersDetails?PID=2310');
  assert.equal(result.details.purchaseDate, '2026-11-09');
  assert.equal(result.details.closingDate, '2026-11-29');
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].label, 'Download tender document');
  assert.equal(result.documents[0].url, 'https://arabpotash.com/documents/202602574.pdf');
});

test('JONEPS sync deduplicates by source and tender ID while updating a closed tender', async () => {
  const originalFetch = global.fetch;
  const makePage = (title, deadline) => '<table><tr><td>2026-991</td><td>' + title + '</td><td>أمانة عمّان الكبرى</td><td>أشغال</td><td>01/11/2026</td><td>' + deadline + '</td></tr></table>';
  let html = makePage('تأهيل طريق تجريبي', '31/12/2099');
  global.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  try {
    const first = await require('../src/lib/joneps-sync').syncJONEPS({ maxPages: 1 });
    assert.deepEqual([first.added, first.updated, first.received], [1, 0, 1]);
    html = makePage('تأهيل طريق تجريبي — تحديث', '01/01/2020');
    const second = await require('../src/lib/joneps-sync').syncJONEPS({ maxPages: 1 });
    assert.deepEqual([second.added, second.updated, second.received], [0, 1, 1]);
    const rows = getDB().prepare("SELECT title,status FROM tender_opportunities WHERE source_key='joneps' AND external_id='2026-991'").all();
    assert.equal(rows.length, 1, 'the same external notice must not create a duplicate');
    assert.equal(rows[0].title, 'تأهيل طريق تجريبي — تحديث');
    assert.equal(rows[0].status, 'closed', 'a passed closing date must update the existing status');
  } finally {
    global.fetch = originalFetch;
  }
});

test('GAM curated import adds verified tenders once and refreshes their deadline status', () => {
  const { syncGAMCurated } = require('../src/lib/gam-curated-sync');
  const { refreshExpiredOpportunities } = require('../src/routes/opportunities');
  const first = syncGAMCurated({ nowLocal: '2026-11-07T08:00' });
  assert.deepEqual([first.added, first.updated, first.normalized, first.snapshotOnly], [14, 0, 14, true]);
  assert.equal(refreshExpiredOpportunities(getDB(), Date.parse('2026-11-23T09:00:01Z')), 2, 'both 23 November deadlines must auto-close after the conservative 11:00 Amman cutoff');
  const mid = getDB().prepare("SELECT status FROM tender_opportunities WHERE source_key='amman' AND external_id='74/1/2026'").get();
  assert.equal(mid.status, 'closed');
  const second = syncGAMCurated({ nowLocal: '2026-11-25T12:01' });
  assert.deepEqual([second.added, second.updated, second.normalized], [0, 14, 14]);
  const rows = getDB().prepare("SELECT status FROM tender_opportunities WHERE source_key='amman' ORDER BY external_id").all();
  assert.equal(rows.length, 14, 'a repeated import must not duplicate GAM tender records');
  assert.ok(rows.every(row => row.status === 'closed'), 'all 14 past deadlines must update the stored status');
});

test('GAM notice closes at the exact 11:00 Amman deadline', () => {
  const { refreshExpiredOpportunities } = require('../src/routes/opportunities');
  const db = getDB();
  db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,closing_at,source_url,status,language)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run('opp-gam-exact-deadline','amman','test-exact-deadline','اختبار حد الإغلاق','أمانة عمّان الكبرى','JO',
      '2026-11-23T11:00:00+03:00','https://www.gamtenders.gov.jo/adlocaltenders.aspx','open','ar');
  assert.equal(refreshExpiredOpportunities(db, Date.parse('2026-11-23T07:59:59.000Z')), 0);
  assert.equal(db.prepare("SELECT status FROM tender_opportunities WHERE external_id='test-exact-deadline'").get().status, 'open');
  assert.equal(refreshExpiredOpportunities(db, Date.parse('2026-11-23T08:00:00.000Z')), 1);
  assert.equal(db.prepare("SELECT status FROM tender_opportunities WHERE external_id='test-exact-deadline'").get().status, 'closed');
});

test('UNGM curated FAO notice respects its 23:59 deadline and shares the existing notice ID for deduplication', () => {
  const { syncUNGMCurated } = require('../src/lib/ungm-curated-sync');
  const { refreshExpiredOpportunities } = require('../src/routes/opportunities');
  const first = syncUNGMCurated({ nowLocal: '2026-11-07T23:58' });
  assert.deepEqual([first.added, first.updated, first.received, first.snapshotOnly], [1, 0, 1, true]);
  assert.equal(refreshExpiredOpportunities(getDB(), Date.parse('2026-11-07T21:00:00Z')), 1, 'FAO notice must close automatically after 23:59 GMT+3');
  const second = syncUNGMCurated({ nowLocal: '2026-11-08T00:00' });
  assert.deepEqual([second.added, second.updated], [0, 1]);
  const rows = getDB().prepare("SELECT title,status,closing_at FROM tender_opportunities WHERE source_key='ungm' AND external_id='318902'").all();
  assert.equal(rows.length, 1, 'the same official UNGM notice must not be duplicated');
  assert.equal(rows[0].title, 'Vehicle to FAO office in Jordan');
  assert.equal(rows[0].closing_at, '2026-11-07T23:59:00+03:00');
  assert.equal(rows[0].status, 'closed');
});

test.after(() => {
  closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { isAllowedPublicDocumentUrl, downloadPublicDocument } = require('../src/lib/public-tender-documents');

test('public tender document allowlist requires HTTPS and the official source domain', () => {
  assert.equal(isAllowedPublicDocumentUrl('apc', 'https://arabpotash.com/files/tender.pdf'), true);
  assert.equal(isAllowedPublicDocumentUrl('apc', 'https://files.arabpotash.com/files/tender.pdf'), true);
  assert.equal(isAllowedPublicDocumentUrl('apc', 'http://arabpotash.com/files/tender.pdf'), false);
  assert.equal(isAllowedPublicDocumentUrl('apc', 'https://arabpotash.com.evil.example/files/tender.pdf'), false);
  assert.equal(isAllowedPublicDocumentUrl('apc', 'https://evil.example/files/tender.pdf'), false);
});

test('public document downloader accepts bounded PDF bytes from an allowlisted official source', async () => {
  const originalFetch = global.fetch;
  const bytes = Buffer.from('%PDF-1.7\n');
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://arabpotash.com/files/tender.pdf');
    assert.equal(options.redirect, 'manual');
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
  };
  try {
    const result = await downloadPublicDocument('apc', 'https://arabpotash.com/files/tender.pdf');
    assert.deepEqual(result.buffer, bytes);
    assert.equal(result.mime, 'application/pdf');
    assert.equal(result.extension, '.pdf');
    assert.equal(result.filename, 'وثيقة العطاء.pdf');
  } finally { global.fetch = originalFetch; }
});

test('public document downloader refuses an official-source redirect to an untrusted host', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/tender.pdf' } });
  try {
    await assert.rejects(downloadPublicDocument('apc', 'https://arabpotash.com/files/tender.pdf'), error => error.code === 'DOCUMENT_REDIRECT_NOT_ALLOWED');
  } finally { global.fetch = originalFetch; }
});
