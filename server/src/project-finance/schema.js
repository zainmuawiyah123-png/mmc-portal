'use strict';

/**
 * MMC Project Finance — additive schema only.
 *
 * This module is intentionally isolated from the production migration runner.
 * It creates project-award / PO / invoice / payment tables only when explicitly
 * invoked by a development migration. It never reads, writes, or alters the
 * MMC subscription invoices table.
 */
function upgradeProjectFinance(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_awards (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL REFERENCES tenders(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      contractor_user_id TEXT NOT NULL REFERENCES users(id),
      award_reference TEXT NOT NULL,
      contract_reference TEXT,
      currency TEXT NOT NULL DEFAULT 'JOD',
      awarded_amount NUMERIC NOT NULL CHECK (awarded_amount > 0),
      awarded_at INTEGER NOT NULL DEFAULT (unixepoch()),
      awarded_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'approved'
        CHECK (status IN ('approved','cancelled','completed')),
      notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tender_id, award_reference)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      award_id TEXT NOT NULL REFERENCES project_awards(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      po_number TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'JOD',
      total_amount NUMERIC NOT NULL CHECK (total_amount > 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','pending_approval','approved','issued','closed','cancelled')),
      payment_terms TEXT,
      requires_owner_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (requires_owner_confirmation IN (0,1)),
      delivery_start TEXT,
      delivery_end TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      approved_by TEXT REFERENCES users(id),
      approved_at INTEGER,
      issued_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(org_id, po_number)
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
      line_no INTEGER NOT NULL,
      description TEXT NOT NULL,
      unit TEXT,
      quantity NUMERIC NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
      line_total NUMERIC NOT NULL CHECK (line_total >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(po_id, line_no)
    );

    CREATE TABLE IF NOT EXISTS project_invoices (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
      award_id TEXT NOT NULL REFERENCES project_awards(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      contractor_user_id TEXT NOT NULL REFERENCES users(id),
      invoice_number TEXT NOT NULL,
      invoice_type TEXT NOT NULL
        CHECK (invoice_type IN ('materials','progress','final')),
      currency TEXT NOT NULL DEFAULT 'JOD',
      gross_amount NUMERIC NOT NULL CHECK (gross_amount > 0),
      retention_amount NUMERIC NOT NULL DEFAULT 0 CHECK (retention_amount >= 0),
      status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted','procurement_review','returned','owner_confirmation','finance_queue','finance_review','approved_for_payment','part_paid','paid','rejected','void')),
      contractor_note TEXT,
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(po_id, invoice_number)
    );

    CREATE TABLE IF NOT EXISTS project_invoice_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE RESTRICT,
      po_item_id TEXT REFERENCES purchase_order_items(id),
      description TEXT NOT NULL,
      quantity NUMERIC NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
      line_total NUMERIC NOT NULL CHECK (line_total >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS project_invoice_reviews (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE RESTRICT,
      reviewer_user_id TEXT NOT NULL REFERENCES users(id),
      reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('procurement','requester','projects','finance')),
      decision TEXT NOT NULL CHECK (decision IN ('accepted','returned','rejected','confirmed','forwarded','approved')),
      note TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS project_payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE RESTRICT,
      org_id TEXT NOT NULL REFERENCES organizations(id),
      amount NUMERIC NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL DEFAULT 'JOD',
      payment_reference TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      recorded_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(org_id, payment_reference)
    );

    CREATE TABLE IF NOT EXISTS project_invoice_documents (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE RESTRICT,
      storage_key TEXT NOT NULL,
      storage_driver TEXT NOT NULL DEFAULT 'local' CHECK (storage_driver IN ('local','s3')),
      original_name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
      checksum TEXT,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS project_audit_events (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id),
      tender_id TEXT REFERENCES tenders(id),
      award_id TEXT REFERENCES project_awards(id),
      po_id TEXT REFERENCES purchase_orders(id),
      invoice_id TEXT REFERENCES project_invoices(id),
      payment_id TEXT REFERENCES project_payments(id),
      actor_user_id TEXT REFERENCES users(id),
      actor_role TEXT,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      detail_json TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_awards_org ON project_awards(org_id, awarded_at);
    CREATE INDEX IF NOT EXISTS idx_po_award ON purchase_orders(award_id, status);
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id, line_no);
    CREATE INDEX IF NOT EXISTS idx_project_inv_po ON project_invoices(po_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_inv_org ON project_invoices(org_id, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_project_reviews_invoice ON project_invoice_reviews(invoice_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_project_payments_invoice ON project_payments(invoice_id, payment_date);
    CREATE INDEX IF NOT EXISTS idx_project_audit_org ON project_audit_events(org_id, created_at);
  `);
  const poColumns = new Set(db.prepare('PRAGMA table_info(purchase_orders)').all().map((row) => row.name));
  if (!poColumns.has('requires_owner_confirmation')) {
    db.exec('ALTER TABLE purchase_orders ADD COLUMN requires_owner_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (requires_owner_confirmation IN (0,1))');
  }
}

module.exports = { upgradeProjectFinance };
