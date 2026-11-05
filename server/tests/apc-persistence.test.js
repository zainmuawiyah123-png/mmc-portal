'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-apc-persist-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(TMP, 'apc-test.sqlite');

const { migrate } = require('../src/migrate');
const { getDB, closeDB } = require('../src/db');
const { persist } = require('../src/lib/apc-sync');
const { persistJonepsDetails } = require('../src/lib/joneps-sync');

test.before(() => { const migrated = migrate(process.env.DB_PATH); migrated.close(); });
test.after(() => {
  closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('APC persistence inserts a notice, stores detail and indexes only public documents', () => {
  const result = persist([{
    pid: 'APC-TEST-001',
    title: 'Civil works package APC-TEST-001',
    purchase: '01/11/2026',
    closing: '20/11/2099',
    fee: '50 JOD',
    bond: '5%',
    qual: 'Class 1 civil contractor',
    remarks: 'Site visit required',
    detailUrl: 'https://www.arabpotash.com/En/TendersDetails?PID=APC-TEST-001',
    docs: [{ label: 'Tender Documents', url: 'https://www.arabpotash.com/files/apc-test.pdf' }]
  }], []);

  assert.deepEqual(
    { added: result.added, updated: result.updated, received: result.received, failed: result.failed },
    { added: 1, updated: 0, received: 1, failed: 0 }
  );
  const db = getDB();
  const row = db.prepare("SELECT * FROM tender_opportunities WHERE source_key='arab-potash-company' AND external_id='APC-TEST-001'").get();
  assert.ok(row);
  assert.equal(row.title, 'Civil works package APC-TEST-001');
  assert.equal(row.closing_at, '2099-11-20');
  assert.equal(row.published_at, null, 'document purchase date must not be mislabeled as publication date');
  const details = db.prepare('SELECT details_json FROM tender_opportunity_details WHERE opportunity_id=?').get(row.id);
  assert.equal(JSON.parse(details.details_json).bond, '5%');
  const docs = db.prepare('SELECT label,document_url FROM tender_opportunity_documents WHERE opportunity_id=?').all(row.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].document_url, 'https://www.arabpotash.com/files/apc-test.pdf');
});

test('APC refresh updates the same notice and removes stale public document links', () => {
  const db = getDB();
  const before = db.prepare("SELECT id FROM tender_opportunities WHERE source_key='arab-potash-company' AND external_id='APC-TEST-001'").get();
  const result = persist([{
    pid: 'APC-TEST-001',
    title: 'Updated civil works package APC-TEST-001',
    purchase: '02/11/2026',
    closing: '21/11/2099',
    fee: '60 JOD',
    bond: '10%',
    qual: 'Updated qualification',
    remarks: 'Updated remarks',
    detailUrl: 'https://www.arabpotash.com/En/TendersDetails?PID=APC-TEST-001',
    docs: [{ label: 'Updated Tender Documents', url: 'https://www.arabpotash.com/files/apc-test-v2.pdf' }]
  }], []);

  assert.deepEqual(
    { added: result.added, updated: result.updated, received: result.received },
    { added: 0, updated: 1, received: 1 }
  );
  const after = db.prepare("SELECT * FROM tender_opportunities WHERE source_key='arab-potash-company' AND external_id='APC-TEST-001'").get();
  assert.equal(after.id, before.id);
  assert.equal(after.title, 'Updated civil works package APC-TEST-001');
  assert.equal(after.closing_at, '2099-11-21');
  const docs = db.prepare('SELECT document_url FROM tender_opportunity_documents WHERE opportunity_id=?').all(after.id);
  assert.deepEqual(docs.map(d => d.document_url), ['https://www.arabpotash.com/files/apc-test-v2.pdf']);
});

test('APC persistence records failed detail fetches without inserting fake notices', () => {
  const result = persist([], [{ id: 'APC-UNREADABLE', message: 'HTTP 403' }]);
  assert.deepEqual(
    { added: result.added, updated: result.updated, received: result.received, failed: result.failed },
    { added: 0, updated: 0, received: 1, failed: 1 }
  );
  assert.equal(
    getDB().prepare("SELECT COUNT(*) AS n FROM tender_opportunities WHERE source_key='arab-potash-company' AND external_id='APC-UNREADABLE'").get().n,
    0
  );
});

test('JONEPS verified detail refresh updates the searchable closing date and indexes public files', () => {
  const db = getDB();
  const id = 'joneps-test-001';
  db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,closing_at,source_url,status,language)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,'joneps','JONEPS-TEST-001','Road works','Public Works','JO','Civil','JONEPS-TEST-001','Imported notice','2099-01-01','https://www.joneps.gov.jo/ep/invt/view.do?id=1','open','ar');
  const stats = persistJonepsDetails([{id:'JONEPS-TEST-001',sourceUrl:'https://www.joneps.gov.jo/ep/invt/view.do?id=1'}], [{
    id:'JONEPS-TEST-001',
    detail:{purchase:'01/11/2026',closing:'20/12/2099',fee:'25 JOD',bond:'5%',qualification:'Class 1',remarks:'Site visit',docs:[{label:'BOQ',url:'https://www.joneps.gov.jo/docs/boq.pdf'}],verified:true}
  }]);
  assert.deepEqual(stats,{detailsSaved:1,documentsSaved:1});
  const row=db.prepare('SELECT closing_at,status FROM tender_opportunities WHERE id=?').get(id);
  assert.equal(row.closing_at,'2099-12-20');
  assert.equal(row.status,'open');
  const docs=db.prepare('SELECT label,document_url FROM tender_opportunity_documents WHERE opportunity_id=?').all(id);
  assert.equal(docs.length,1);
  assert.equal(docs[0].document_url,'https://www.joneps.gov.jo/docs/boq.pdf');
});
