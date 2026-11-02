'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-project-finance-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(TMP, 'project-finance.db');
process.env.JWT_SECRET = 'isolated-project-finance-test-secret';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');

const { migrate } = require('../src/migrate');

test('project finance migration is additive and repeatable', () => {
  const first = migrate(process.env.DB_PATH);
  const invoiceColumnsBefore = first.prepare('PRAGMA table_info(invoices)').all().map((x) => x.name);
  const required = [
    'project_awards','purchase_orders','purchase_order_items',
    'project_invoices','project_invoice_items','project_invoice_reviews',
    'project_payments','project_invoice_documents','project_audit_events'
  ];
  for (const name of required) {
    assert.ok(first.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name), 'missing table: ' + name);
  }
  assert.ok(invoiceColumnsBefore.includes('plan_key'));
  assert.ok(invoiceColumnsBefore.includes('billing_cycle'));
  assert.ok(!invoiceColumnsBefore.includes('po_id'));
  first.close();

  const second = migrate(process.env.DB_PATH);
  const invoiceColumnsAfter = second.prepare('PRAGMA table_info(invoices)').all().map((x) => x.name);
  assert.deepEqual(invoiceColumnsAfter, invoiceColumnsBefore, 'MMC subscription invoice schema must remain unchanged');
  const poColumns = second.prepare('PRAGMA table_info(purchase_orders)').all().map((x) => x.name);
  assert.ok(poColumns.includes('requires_owner_confirmation'));
  second.close();
});

test('project workflow schema keeps financial records separate from subscription invoices', () => {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH);
  const invoiceColumns = db.prepare('PRAGMA table_info(invoices)').all().map((x) => x.name);
  const projectInvoiceColumns = db.prepare('PRAGMA table_info(project_invoices)').all().map((x) => x.name);
  assert.ok(invoiceColumns.includes('user_id'));
  assert.ok(invoiceColumns.includes('plan_key'));
  assert.ok(!invoiceColumns.includes('contractor_user_id'));
  assert.ok(projectInvoiceColumns.includes('contractor_user_id'));
  assert.ok(projectInvoiceColumns.includes('po_id'));
  db.close();
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
