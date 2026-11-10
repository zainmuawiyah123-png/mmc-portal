'use strict';
/**
 * تهيئة قاعدة البيانات — تُنشئ الجداول والفهارس والباقات الأربع.
 * قابلة للتشغيل أكثر من مرة (idempotent).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ users ============
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  company       TEXT,
  plan_key      TEXT NOT NULL DEFAULT 'free',
  plan_started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER,
  role          TEXT NOT NULL DEFAULT 'contractor' -- contractor | buyer | admin
);

-- ============ plans ============
CREATE TABLE IF NOT EXISTS plans (
  key         TEXT PRIMARY KEY,
  name_ar     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  max_tenders INTEGER NOT NULL,          -- -1 = غير محدود
  max_bytes   INTEGER NOT NULL,          -- -1 = غير محدود
  price_month REAL NOT NULL DEFAULT 0,
  price_year  REAL NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ============ subscriptions ============
CREATE TABLE IF NOT EXISTS subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_key   TEXT NOT NULL REFERENCES plans(key),
  status     TEXT NOT NULL DEFAULT 'active',   -- active | cancelled | expired
  source     TEXT NOT NULL DEFAULT 'manual',   -- manual | trial | stripe
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ends_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subs_user   ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);

-- ============ billing / invoices ============
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL REFERENCES plans(key),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly', -- monthly | annual
  currency TEXT NOT NULL DEFAULT 'USD',
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | rejected | cancelled | refunded
  payment_method TEXT NOT NULL DEFAULT 'bank_transfer', -- bank_transfer | card | cliq
  transfer_reference TEXT,
  transfer_date TEXT,
  receipt_storage_key TEXT,
  receipt_storage_driver TEXT,
  receipt_original_name TEXT,
  receipt_mime TEXT,
  receipt_size INTEGER,
  receipt_checksum_sha256 TEXT,
  receipt_uploaded_at INTEGER,
  paid_at INTEGER,
  due_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, created_at DESC);

-- ============ tenders ============
CREATE TABLE IF NOT EXISTS tenders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  authority  TEXT,
  closing    TEXT,
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'new',      -- new | proc | ready
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reference TEXT,
  technical_weight REAL NOT NULL DEFAULT 60,
  financial_weight REAL NOT NULL DEFAULT 40,
  technical_threshold REAL NOT NULL DEFAULT 50,
  procurement_status TEXT NOT NULL DEFAULT 'private', -- private | published | closed
  financial_opened_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tenders_user ON tenders(user_id, updated_at DESC);

-- ============ electronic procurement ============
CREATE TABLE IF NOT EXISTS tender_requirements (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  weight REAL NOT NULL DEFAULT 0,
  mandatory INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requirements_tender ON tender_requirements(tender_id, sort_order);

CREATE TABLE IF NOT EXISTS bid_submissions (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | evaluated | withdrawn
  technical_score REAL NOT NULL DEFAULT 0,
  technical_points REAL NOT NULL DEFAULT 0,
  technical_passed INTEGER NOT NULL DEFAULT 0,
  financial_amount REAL NOT NULL,
  financial_currency TEXT NOT NULL DEFAULT 'JOD',
  financial_unlocked INTEGER NOT NULL DEFAULT 0,
  financial_score REAL,
  total_score REAL,
  submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  evaluated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_unique ON bid_submissions(tender_id, contractor_id);
CREATE INDEX IF NOT EXISTS idx_submission_tender ON bid_submissions(tender_id, submitted_at);

CREATE TABLE IF NOT EXISTS bid_responses (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES bid_submissions(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES tender_requirements(id) ON DELETE CASCADE,
  answer TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  evaluator_note TEXT,
  UNIQUE(submission_id, requirement_id)
);

-- ============ files ============
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  tender_id   TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',   -- arch | struct | mep | tender | boq | other
  size        INTEGER NOT NULL,
  mime        TEXT,
  uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_files_tender ON files(tender_id);
CREATE INDEX IF NOT EXISTS idx_files_user   ON files(user_id);

-- ============ audit_log (سجل تدقيق الرفع/التحميل/الحذف/النسخ الاحتياطي) ============
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL DEFAULT (unixepoch()),
  action     TEXT NOT NULL,          -- upload | download | delete | backup | restore | migrate | signed_url
  entity     TEXT,                   -- file | tender | db | system
  entity_id  TEXT,
  user_id    TEXT,
  actor      TEXT,                   -- user id أو 'system'
  driver     TEXT,
  detail     TEXT,                   -- JSON
  ip         TEXT,
  ok         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ============ requests (استفسارات / طلبات تعديل) ============
CREATE TABLE IF NOT EXISTS requests (
  id         TEXT PRIMARY KEY,
  tender_id  TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'note',     -- note | change | question
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',     -- open | closed
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_requests_tender ON requests(tender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_user   ON requests(user_id);
`;

const PLANS_SEED = [
  ['free',    'تجريبي مجاني', 'Free Trial',    1,  25 * 1024 * 1024,   0,    0, 1],
  ['starter', 'Starter',      'Starter',       3,  200 * 1024 * 1024,  39,  390, 2],
  ['pro',     'Professional', 'Professional', 15,  1024 * 1024 * 1024, 89,  890, 3],
  ['ent',     'Enterprise',   'Enterprise',   -1,  -1,                 199, 1990, 4],
  ['proc_basic', 'المشتريات المجانية', 'Free Procurement', -1, -1, 0, 0, 5],
  ['proc_pro',   'المشتريات المجانية', 'Free Procurement', -1, -1, 0, 0, 6],
  ['proc_ent',   'المشتريات المجانية', 'Free Procurement', -1, -1, 0, 0, 7],
  ['consultant_20', 'اشتراك المكتب الاستشاري', 'Consultant subscription', -1, 5 * 1024 * 1024 * 1024, 20, 200, 8]
];
// عدد المستخدمين المسموح (-1 = غير محدود) — للعرض حالياً؛ لا يوجد نموذج منظمة/مقاعد بعد
const PLAN_SEATS = { free: 1, starter: 1, pro: 10, ent: -1, proc_basic: 3, proc_pro: 10, proc_ent: -1, consultant_20: -1 };
// عدد التقديمات الإلكترونية على عطاءات المنصة خلال 365 يوماً (-1 = غير محدود). حدّ مساحة العمل (max_tenders) منفصل عنه
const PLAN_SUBMISSIONS = { free: 2, starter: 10, pro: 40, ent: -1, proc_basic: -1, proc_pro: -1, proc_ent: -1, consultant_20: -1 };
const TRIAL_DAYS = 14;

/**
 * ترقية المخطط لقواعد بيانات أنشئت في المرحلة الأولى (v4).
 * SQLite لا يدعم ADD COLUMN IF NOT EXISTS، لذا نفحص PRAGMA table_info أولاً.
 * idempotent: تشغيلها مرتين لا يغيّر شيئاً.
 */
const PROCUREMENT_COLUMNS = [
  ['role', "TEXT NOT NULL DEFAULT 'contractor'"],
  ['reference', 'TEXT'],
  ['technical_weight', 'REAL NOT NULL DEFAULT 60'],
  ['financial_weight', 'REAL NOT NULL DEFAULT 40'],
  ['technical_threshold', 'REAL NOT NULL DEFAULT 50'],
  ['procurement_status', "TEXT NOT NULL DEFAULT 'private'"],
  ['financial_opened_at', 'INTEGER']
];

const FILE_COLUMNS_V5 = [
  // المفتاح المنظّم داخل مشغّل التخزين (users/<uid>/tenders/<tid>/<uuid>.<ext>)
  ['storage_key', 'TEXT'],
  // المشغّل الذي يحمل الملف فعلاً — يسمح بوجود ملفات محلية وأخرى سحابية في نفس القاعدة أثناء الترحيل
  ['storage_driver', "TEXT DEFAULT 'local'"],
  // SHA-256 للمحتوى — أساس التحقق بعد الرفع والترحيل
  ['checksum_sha256', 'TEXT'],
  // يُملأ عند الترحيل الناجح إلى السحابة
  ['migrated_at', 'INTEGER']
];

function upgradeProcurement(db) {
  const users = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const tenders = new Set(db.prepare('PRAGMA table_info(tenders)').all().map((c) => c.name));
  for (const [name, type] of PROCUREMENT_COLUMNS) {
    const table = name === 'role' ? 'users' : 'tenders';
    const set = table === 'users' ? users : tenders;
    if (!set.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function upgradeWorkflow(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- صاحب الاشتراك (الفوترة)
      require_approval INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,   -- manager | requester | projects | procurement
      joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (org_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS org_invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      label TEXT,
      role TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | used | revoked
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      used_by TEXT
    );
    CREATE TABLE IF NOT EXISTS project_requests (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES users(id),
      assigned_to TEXT,
      title TEXT NOT NULL,
      title_en TEXT,
      description TEXT,
      location TEXT,
      country TEXT,
      service_type TEXT,
      budget REAL,
      currency TEXT,
      needed_by TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      fidic_book TEXT,
      fidic_edition TEXT,
      particular_notes TEXT,
      review_note TEXT,
      tender_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      submitted_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_req_org ON project_requests(org_id, status);
    CREATE TABLE IF NOT EXISTS request_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
      user_id TEXT,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_reqev_req ON request_events(request_id, at);
    CREATE TABLE IF NOT EXISTS request_docs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,   -- brief | drawings | specifications | boq | conditions | particular_conditions | internal
      storage_key TEXT NOT NULL,
      storage_driver TEXT NOT NULL DEFAULT 'local',
      original_name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      uploaded_by TEXT,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_reqdocs_req ON request_docs(request_id);
  `);
  const addCol = (table, col, def) => {
    const cols = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name));
    if (!cols.has(col)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def);
  };
  addCol('org_verifications', 'org_id', 'TEXT');
  addCol('tenders', 'org_id', 'TEXT');
  addCol('tenders', 'request_id', 'TEXT');

  // ترحيل: لكل حساب مشتريات قائم جهة خاصة به (هو مديرها) حتى لا تتأثر بياناته
  const { randomUUID } = require('crypto');
  const orphans = db.prepare("SELECT u.id, u.name, u.company FROM users u WHERE u.role = 'buyer' AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = u.id)").all();
  const mk = db.transaction(() => {
    orphans.forEach((u) => {
      const v = db.prepare('SELECT org_name FROM org_verifications WHERE user_id = ?').get(u.id);
      const id = 'org_' + randomUUID();
      db.prepare('INSERT INTO organizations (id, name, created_by) VALUES (?,?,?)').run(id, (v && v.org_name) || u.company || u.name || 'جهة', u.id);
      db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,'manager')").run(id, u.id);
      db.prepare('UPDATE org_verifications SET org_id = ? WHERE user_id = ? AND org_id IS NULL').run(id, u.id);
      db.prepare('UPDATE tenders SET org_id = ? WHERE user_id = ? AND org_id IS NULL').run(id, u.id);
    });
  });
  mk();
}

function upgradeBilingual(db) {
  const add = (table, col) => {
    const cols = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name));
    if (!cols.has(col)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' TEXT');
  };
  add('tenders', 'name_en'); add('tenders', 'notes_en');
  add('tender_requirements', 'title_en'); add('tender_requirements', 'description_en');
}

function upgradeOrg(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      org_name TEXT NOT NULL,
      org_type TEXT NOT NULL,
      country TEXT NOT NULL,
      reg_number TEXT NOT NULL,
      official_phone TEXT NOT NULL,
      official_email TEXT NOT NULL,
      on_behalf_of TEXT,
      website TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | rejected | revoked
      review_note TEXT,
      reviewed_by TEXT,
      reviewed_at INTEGER,
      verified_at INTEGER,
      expires_at INTEGER,
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_orgver_status ON org_verifications(status, submitted_at);
    CREATE TABLE IF NOT EXISTS org_verification_docs (
      id TEXT PRIMARY KEY,
      verification_id TEXT NOT NULL REFERENCES org_verifications(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      storage_driver TEXT NOT NULL DEFAULT 'local',
      original_name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_orgdocs_ver ON org_verification_docs(verification_id);
  `);
  const tc = new Set(db.prepare('PRAGMA table_info(tenders)').all().map((c) => c.name));
  if (!tc.has('country')) db.exec("ALTER TABLE tenders ADD COLUMN country TEXT NOT NULL DEFAULT 'JO'");
}

function upgradePlans(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name));
  if (!cols.has('audience')) db.exec("ALTER TABLE plans ADD COLUMN audience TEXT NOT NULL DEFAULT 'contractor'");
  if (!cols.has('max_users')) db.exec('ALTER TABLE plans ADD COLUMN max_users INTEGER NOT NULL DEFAULT 1');
  if (!cols.has('trial_days')) db.exec('ALTER TABLE plans ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE plans SET audience='buyer', trial_days=0 WHERE key LIKE 'proc\\_%' ESCAPE '\\'").run();
  db.prepare("UPDATE plans SET audience='consultant', trial_days=0 WHERE key='consultant_20'").run();
  if (!cols.has('max_submissions')) db.exec('ALTER TABLE plans ADD COLUMN max_submissions INTEGER NOT NULL DEFAULT -1');
  const upS = db.prepare('UPDATE plans SET max_submissions=? WHERE key=?');
  Object.entries(PLAN_SUBMISSIONS).forEach(([k, v]) => upS.run(v, k));
  const up = db.prepare('UPDATE plans SET max_users=? WHERE key=?');
  Object.entries(PLAN_SEATS).forEach(([k, v]) => up.run(v, k));
}

function upgradeV5(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(files)').all().map((c) => c.name));
  const added = [];
  for (const [name, type] of FILE_COLUMNS_V5) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
      added.push(name);
    }
  }
  // فهارس جديدة تعتمد على الأعمدة المضافة — تُنشأ بعد التأكد من وجودها
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_storage_key ON files(storage_key)');
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_driver ON files(storage_driver)");
  return added;
}


/**
 * Project award, purchase order and invoice workflow.
 * Additive and idempotent: never alters or drops existing MMC tables or records.
 */
function upgradeProjectFinance(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_audit_events (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id),
      tender_id TEXT REFERENCES tenders(id),
      award_id TEXT,
      po_id TEXT,
      invoice_id TEXT,
      payment_id TEXT,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_role TEXT,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      detail_json TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS project_awards (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL REFERENCES tenders(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      contractor_user_id TEXT NOT NULL REFERENCES users(id),
      award_reference TEXT NOT NULL,
      contract_reference TEXT,
      currency TEXT NOT NULL,
      awarded_amount REAL NOT NULL CHECK (awarded_amount > 0),
      status TEXT NOT NULL DEFAULT 'approved',
      awarded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      awarded_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      award_id TEXT NOT NULL REFERENCES project_awards(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      po_number TEXT NOT NULL,
      currency TEXT NOT NULL,
      total_amount REAL NOT NULL CHECK (total_amount > 0),
      status TEXT NOT NULL DEFAULT 'pending_approval',
      payment_terms TEXT,
      delivery_start TEXT,
      delivery_end TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at INTEGER,
      issued_at INTEGER,
      requires_owner_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (requires_owner_confirmation IN (0,1)),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(org_id, po_number)
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit_price REAL NOT NULL CHECK (unit_price >= 0),
      line_total REAL NOT NULL CHECK (line_total >= 0),
      unit TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(po_id, line_no)
    );

    CREATE TABLE IF NOT EXISTS project_invoices (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL REFERENCES purchase_orders(id),
      award_id TEXT NOT NULL REFERENCES project_awards(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      contractor_user_id TEXT NOT NULL REFERENCES users(id),
      invoice_number TEXT NOT NULL,
      invoice_type TEXT NOT NULL CHECK (invoice_type IN ('materials','progress','final')),
      currency TEXT NOT NULL,
      gross_amount REAL NOT NULL CHECK (gross_amount > 0),
      retention_amount REAL NOT NULL DEFAULT 0 CHECK (retention_amount >= 0),
      contractor_note TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(contractor_user_id, invoice_number)
    );

    CREATE TABLE IF NOT EXISTS project_invoice_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit_price REAL NOT NULL CHECK (unit_price >= 0),
      line_total REAL NOT NULL CHECK (line_total >= 0),
      po_item_id TEXT REFERENCES purchase_order_items(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS project_invoice_reviews (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE CASCADE,
      reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewer_role TEXT NOT NULL,
      decision TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS project_payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      amount REAL NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(org_id, payment_reference)
    );

    CREATE TABLE IF NOT EXISTS project_invoice_documents (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES project_invoices(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      storage_driver TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL CHECK (size >= 0),
      checksum TEXT,
      uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_awards_one_approved_per_tender ON project_awards(tender_id) WHERE status='approved';
    CREATE INDEX IF NOT EXISTS idx_project_awards_org ON project_awards(org_id, awarded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_awards_contractor ON project_awards(contractor_user_id, awarded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_org ON purchase_orders(org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_award ON purchase_orders(award_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_invoices_org ON project_invoices(org_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_invoices_contractor ON project_invoices(contractor_user_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_invoices_po ON project_invoices(po_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_invoice_reviews_invoice ON project_invoice_reviews(invoice_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_project_payments_invoice ON project_payments(invoice_id, payment_date);
    CREATE INDEX IF NOT EXISTS idx_project_invoice_documents_invoice ON project_invoice_documents(invoice_id, uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_project_audit_org ON project_audit_events(org_id, created_at DESC);
  `);
}


function upgradeMultiCountry(db) {
  // Additive only: existing users and organizations retain all records and receive
  // a nullable country until explicitly selected/updated.
  const add = (table, column, definition) => {
    const columns = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name));
    if (!columns.has(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  };
  add('users', 'country', 'TEXT');
  add('organizations', 'country', 'TEXT');
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_country ON users(country)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_organizations_country ON organizations(country)");
}

function upgradeOpportunitySyncRuns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_sync_runs (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','failed','skipped')),
      received INTEGER NOT NULL DEFAULT 0,
      added INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_opportunity_sync_runs_source
      ON opportunity_sync_runs(source_key, finished_at DESC);
  `);
}

function upgradeTenderOpportunities(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tender_opportunities (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      authority TEXT,
      country TEXT NOT NULL DEFAULT 'JO',
      sector TEXT,
      tender_number TEXT,
      summary TEXT,
      published_at TEXT,
      closing_at TEXT,
      source_url TEXT NOT NULL,
      application_url TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled','draft')),
      language TEXT NOT NULL DEFAULT 'ar',
      imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(source_key, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tender_opportunities_public
      ON tender_opportunities(status, country, closing_at);
    CREATE INDEX IF NOT EXISTS idx_tender_opportunities_source
      ON tender_opportunities(source_key, imported_at DESC);
  `);
}


function upgradeTenderOpportunityDocuments(db) {
  const opportunityCols = new Set(db.prepare('PRAGMA table_info(tender_opportunities)').all().map(c => c.name));
  if (!opportunityCols.has('details_json')) db.exec('ALTER TABLE tender_opportunities ADD COLUMN details_json TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tender_opportunity_public_documents (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL REFERENCES tender_opportunities(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      document_url TEXT NOT NULL,
      availability TEXT NOT NULL DEFAULT 'public-source-link',
      storage_key TEXT,
      storage_driver TEXT,
      content_type TEXT,
      file_size INTEGER,
      checksum_sha256 TEXT,
      downloaded_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(opportunity_id, document_url)
    );
    CREATE INDEX IF NOT EXISTS idx_tender_public_documents_opportunity
      ON tender_opportunity_public_documents(opportunity_id, created_at);
  `);
  const documentCols = new Set(db.prepare('PRAGMA table_info(tender_opportunity_public_documents)').all().map(c => c.name));
  const additions = {
    availability: "TEXT NOT NULL DEFAULT 'public-source-link'",
    storage_key: 'TEXT',
    storage_driver: 'TEXT',
    content_type: 'TEXT',
    file_size: 'INTEGER',
    checksum_sha256: 'TEXT',
    downloaded_at: 'INTEGER'
  };
  for (const [name, type] of Object.entries(additions)) {
    if (!documentCols.has(name)) db.exec('ALTER TABLE tender_opportunity_public_documents ADD COLUMN ' + name + ' ' + type);
  }
}


function upgradeBidSubmissionDocuments(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(bid_submissions)').all().map((c) => c.name));
  if (!cols.has('receipt_reference')) db.exec('ALTER TABLE bid_submissions ADD COLUMN receipt_reference TEXT');
  if (!cols.has('declaration_accepted')) db.exec('ALTER TABLE bid_submissions ADD COLUMN declaration_accepted INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('submitted_ip')) db.exec('ALTER TABLE bid_submissions ADD COLUMN submitted_ip TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bid_submission_docs (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES bid_submissions(id) ON DELETE CASCADE,
      doc_class TEXT NOT NULL CHECK (doc_class IN ('technical','financial')),
      storage_key TEXT NOT NULL,
      storage_driver TEXT NOT NULL DEFAULT 'local',
      original_name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      checksum_sha256 TEXT,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_bid_docs_submission_class
      ON bid_submission_docs(submission_id, doc_class, uploaded_at);
  `);
}


/** طابور البريد + لجنة تقييم العروض (مقيّمون مستقلون، درجات منفصلة، اعتماد جماعي) */
function upgradeCommitteeAndMail(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | skipped
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status, created_at);
    CREATE TABLE IF NOT EXISTS tender_evaluators (
      tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_role TEXT NOT NULL DEFAULT 'member',   -- chair | member | consultant
      invited_by TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (tender_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evaluators_user ON tender_evaluators(user_id);
    CREATE TABLE IF NOT EXISTS evaluator_scores (
      submission_id TEXT NOT NULL REFERENCES bid_submissions(id) ON DELETE CASCADE,
      requirement_id TEXT NOT NULL,
      evaluator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (submission_id, requirement_id, evaluator_id)
    );
    CREATE TABLE IF NOT EXISTS tender_committee (
      tender_id TEXT PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE,
      finalized_at INTEGER,
      finalized_by TEXT
    );
  `);
}


/** الفوترة الوطنية: سجل إرسال لكل فاتورة اشتراك + عدّاد ICV متسلسل بلا فجوات + الرقم الضريبي للمشتري */
function upgradeEInvoice(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS einvoice_submissions (
      invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
      icv INTEGER NOT NULL UNIQUE,
      uuid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected | error
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      einv_number TEXT,
      qr TEXT,
      response TEXT,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      submitted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_einv_status ON einvoice_submissions(status, updated_at);
  `);
  const cols = new Set(db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name));
  if (!cols.has('buyer_tax_number')) db.exec('ALTER TABLE invoices ADD COLUMN buyer_tax_number TEXT');
}


/** مفضلة العطاءات الخارجية لكل مستخدم */
function upgradeOpportunityWatch(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_saved (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opportunity_id TEXT NOT NULL REFERENCES tender_opportunities(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, opportunity_id)
    );
  `);
}


/**
 * Independent consulting-firm identity and membership.
 * Additive/idempotent only. Does not reuse buyer organizations or evaluator assignments.
 */
function upgradeConsultingPortal(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_firms (
      id TEXT PRIMARY KEY,
      legal_name TEXT NOT NULL,
      country TEXT NOT NULL CHECK(country IN ('JO','SA','AE')),
      registration_number TEXT NOT NULL,
      identity_key TEXT NOT NULL UNIQUE,
      contact_email TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      specializations_json TEXT NOT NULL DEFAULT '[]',
      experience_summary TEXT,
      website TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','rejected','suspended')),
      verification_note TEXT,
      verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      verified_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_firm_members (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      member_role TEXT NOT NULL DEFAULT 'owner' CHECK(member_role IN ('owner','manager','staff')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','invited','suspended')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(firm_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS consulting_firm_verification_events (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL CHECK(action IN ('submitted','verified','rejected','suspended','reopened','pending')),
      note TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_firms_status ON consulting_firms(verification_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_members_firm ON consulting_firm_members(firm_id, status);
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_events_firm ON consulting_firm_verification_events(firm_id, created_at DESC);
  `);
}


/** Independent consultancy marketplace: requester entities, requests, proposals and contracts. */
function upgradeConsultingOfficeTenderDocuments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_firm_tender_documents (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL REFERENCES consulting_firm_tenders(id) ON DELETE CASCADE,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      document_kind TEXT NOT NULL CHECK(document_kind IN ('brief','scope','reference','other')),
      storage_key TEXT NOT NULL UNIQUE,
      storage_driver TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_firm_tender_proposal_documents (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL REFERENCES consulting_firm_tenders(id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES consulting_firm_tender_proposals(id) ON DELETE CASCADE,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      document_kind TEXT NOT NULL CHECK(document_kind IN ('technical','financial','reference','other')),
      storage_key TEXT NOT NULL UNIQUE,
      storage_driver TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_tender_documents ON consulting_firm_tender_documents(tender_id,uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_tender_proposal_documents ON consulting_firm_tender_proposal_documents(proposal_id,uploaded_at DESC);
  `);
}

function upgradeConsultingOfficeOperations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_firm_subcontract_updates (
      id TEXT PRIMARY KEY,
      subcontract_id TEXT NOT NULL REFERENCES consulting_firm_subcontracts(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      update_type TEXT NOT NULL CHECK(update_type IN ('progress','milestone','issue','status')),
      progress_percent INTEGER CHECK(progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_firm_subcontract_documents (
      id TEXT PRIMARY KEY,
      subcontract_id TEXT NOT NULL REFERENCES consulting_firm_subcontracts(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      document_kind TEXT NOT NULL CHECK(document_kind IN ('contract','technical','financial','deliverable','report','other')),
      storage_key TEXT NOT NULL UNIQUE,
      storage_driver TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_subcontract_updates ON consulting_firm_subcontract_updates(subcontract_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_subcontract_documents ON consulting_firm_subcontract_documents(subcontract_id,uploaded_at DESC);
  `);
}

function upgradeConsultingOfficeTendering(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_firm_tenders (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      discipline TEXT NOT NULL CHECK(discipline IN ('engineering_design','site_supervision','project_management','quantity_surveying','geotechnical','environmental','transportation','water_wastewater','architecture','other')),
      country TEXT NOT NULL CHECK(country IN ('JO','SA','AE')),
      location TEXT,
      description TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '[]',
      currency TEXT NOT NULL CHECK(currency IN ('USD','JOD','SAR','AED')),
      budget_min REAL,
      budget_max REAL,
      closing_at INTEGER,
      technical_threshold INTEGER NOT NULL DEFAULT 50 CHECK(technical_threshold BETWEEN 1 AND 100),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','awarded','cancelled')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_firm_tender_proposals (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL REFERENCES consulting_firm_tenders(id) ON DELETE CASCADE,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      submitted_by TEXT NOT NULL REFERENCES users(id),
      technical_summary TEXT NOT NULL,
      methodology TEXT,
      team_summary TEXT,
      financial_amount REAL NOT NULL CHECK(financial_amount > 0),
      currency TEXT NOT NULL CHECK(currency IN ('USD','JOD','SAR','AED')),
      duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 3650),
      technical_score REAL CHECK(technical_score IS NULL OR technical_score BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','qualified','rejected','selected')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tender_id,firm_id)
    );
    CREATE TABLE IF NOT EXISTS consulting_firm_subcontracts (
      id TEXT PRIMARY KEY,
      tender_id TEXT NOT NULL UNIQUE REFERENCES consulting_firm_tenders(id),
      proposal_id TEXT NOT NULL UNIQUE REFERENCES consulting_firm_tender_proposals(id),
      owner_firm_id TEXT NOT NULL REFERENCES consulting_firms(id),
      selected_firm_id TEXT NOT NULL REFERENCES consulting_firms(id),
      contract_reference TEXT NOT NULL UNIQUE,
      agreed_amount REAL NOT NULL CHECK(agreed_amount > 0),
      currency TEXT NOT NULL CHECK(currency IN ('USD','JOD','SAR','AED')),
      status TEXT NOT NULL DEFAULT 'awarded' CHECK(status IN ('awarded','active','completed','terminated')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_tenders_market ON consulting_firm_tenders(status,country,closing_at);
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_tenders_owner ON consulting_firm_tenders(firm_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_proposals_tender ON consulting_firm_tender_proposals(tender_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_proposals_firm ON consulting_firm_tender_proposals(firm_id,created_at DESC);
  `);
}

function upgradeConsultingFirmDocuments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_firm_documents (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id) ON DELETE CASCADE,
      document_kind TEXT NOT NULL CHECK(document_kind IN ('registration','professional_license','tax_certificate','insurance','portfolio','authorization','other')),
      storage_key TEXT NOT NULL UNIQUE,
      storage_driver TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_firm_documents_firm ON consulting_firm_documents(firm_id,uploaded_at DESC);
  `);
}

function upgradeConsultingMarketplace(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_requester_entities (
      id TEXT PRIMARY KEY,
      legal_name TEXT NOT NULL,
      country TEXT NOT NULL CHECK(country IN ('JO','SA','AE')),
      registration_number TEXT NOT NULL,
      identity_key TEXT NOT NULL UNIQUE,
      contact_email TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','rejected','suspended')),
      verification_note TEXT,
      verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      verified_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_requester_members (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES consulting_requester_entities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      member_role TEXT NOT NULL DEFAULT 'owner' CHECK(member_role IN ('owner','requester')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(entity_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS consulting_service_requests (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      requester_entity_id TEXT NOT NULL REFERENCES consulting_requester_entities(id),
      created_by TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      discipline TEXT NOT NULL,
      country TEXT NOT NULL CHECK(country IN ('JO','SA','AE')),
      location TEXT,
      description TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '[]',
      currency TEXT NOT NULL CHECK(currency IN ('USD','JOD','SAR','AED')),
      budget_min REAL,
      budget_max REAL,
      closing_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','awarded','cancelled')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_proposals (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES consulting_service_requests(id) ON DELETE CASCADE,
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id),
      submitted_by TEXT NOT NULL REFERENCES users(id),
      technical_summary TEXT NOT NULL,
      methodology TEXT,
      team_summary TEXT,
      financial_amount REAL NOT NULL CHECK(financial_amount > 0),
      currency TEXT NOT NULL CHECK(currency IN ('USD','JOD','SAR','AED')),
      duration_days INTEGER NOT NULL CHECK(duration_days > 0),
      validity_until TEXT,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','withdrawn','selected','rejected')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(request_id,firm_id)
    );
    CREATE TABLE IF NOT EXISTS consulting_contracts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES consulting_service_requests(id),
      proposal_id TEXT NOT NULL UNIQUE REFERENCES consulting_proposals(id),
      requester_entity_id TEXT NOT NULL REFERENCES consulting_requester_entities(id),
      firm_id TEXT NOT NULL REFERENCES consulting_firms(id),
      contract_reference TEXT NOT NULL UNIQUE,
      agreed_amount REAL NOT NULL CHECK(agreed_amount > 0),
      currency TEXT NOT NULL CHECK(currency IN ('USD','JOD','SAR','AED')),
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'awarded' CHECK(status IN ('awarded','active','completed','terminated')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS consulting_documents (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('request','proposal','contract')),
      owner_id TEXT NOT NULL,
      request_id TEXT NOT NULL REFERENCES consulting_service_requests(id) ON DELETE CASCADE,
      firm_id TEXT REFERENCES consulting_firms(id) ON DELETE CASCADE,
      requester_entity_id TEXT REFERENCES consulting_requester_entities(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'market' CHECK(visibility IN ('market','selected_only')),
      document_kind TEXT NOT NULL DEFAULT 'other' CHECK(document_kind IN ('brief','scope','reference','technical','financial','contract','deliverable','report','other')),
      storage_key TEXT NOT NULL UNIQUE,
      storage_driver TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_docs_request ON consulting_documents(request_id,owner_type,owner_id,uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_consulting_docs_firm ON consulting_documents(firm_id,uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_consulting_docs_requester ON consulting_documents(requester_entity_id,uploaded_at);
    CREATE TABLE IF NOT EXISTS consulting_market_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_requester_status ON consulting_requester_entities(verification_status,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_requests_open ON consulting_service_requests(status,country,closing_at);
    CREATE INDEX IF NOT EXISTS idx_consulting_requests_owner ON consulting_service_requests(requester_entity_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_proposals_firm ON consulting_proposals(firm_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_proposals_request ON consulting_proposals(request_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_consulting_contracts_firm ON consulting_contracts(firm_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_contracts_requester ON consulting_contracts(requester_entity_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consulting_market_events_entity ON consulting_market_events(entity_type,entity_id,created_at DESC);
  `);
}


function upgradeConsultingContractTracking(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consulting_contract_updates (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES consulting_contracts(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      update_type TEXT NOT NULL CHECK(update_type IN ('progress','milestone','issue','status')),
      progress_percent INTEGER CHECK(progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_consulting_contract_updates_contract
      ON consulting_contract_updates(contract_id,created_at DESC);
  `);
}


/**
 * MMC AI project workspace — separate from tender and procurement records.
 * Idempotent: creates only additive tables and indexes; never rewrites legacy rows.
 */
function upgradeMmcAiProjects(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      country TEXT,
      currency TEXT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_projects_creator ON ai_projects(created_by,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_projects_org ON ai_projects(org_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS ai_project_members (
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','project_manager','engineer','quantity_surveyor','reviewer','viewer')),
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(project_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_project_members_user ON ai_project_members(user_id,project_id);

    CREATE TABLE IF NOT EXISTS ai_audit_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      detail_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_audit_project ON ai_audit_log(project_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_audit_actor ON ai_audit_log(actor_user_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS ai_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      original_name TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      processing_status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK(processing_status IN ('uploaded','queued','processing','completed','failed','quarantined')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_documents_project ON ai_documents(project_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_documents_uploader ON ai_documents(uploaded_by,created_at DESC);

    CREATE TABLE IF NOT EXISTS ai_project_images (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
      size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      caption TEXT,
      captured_at TEXT,
      is_cover INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0,1)),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_project_images_project ON ai_project_images(project_id,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_project_single_cover ON ai_project_images(project_id) WHERE is_cover=1;

    CREATE TABLE IF NOT EXISTS ai_takeoff_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES ai_documents(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      engine TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status IN ('needs_review','approved','rejected')),
      units_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      unsupported_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_takeoff_runs_project ON ai_takeoff_runs(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_takeoff_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES ai_takeoff_runs(id) ON DELETE CASCADE,
      entity_index INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      layer_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK(review_status IN ('needs_review','approved','rejected'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_takeoff_items_run ON ai_takeoff_items(run_id,entity_index);

    CREATE TABLE IF NOT EXISTS ai_boq_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      item_code TEXT,
      description TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity >= 0),
      rate REAL NOT NULL CHECK(rate >= 0),
      source_takeoff_item_id TEXT REFERENCES ai_takeoff_items(id) ON DELETE SET NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_boq_project ON ai_boq_items(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_schedule_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      task_code TEXT,
      name TEXT NOT NULL,
      duration_days INTEGER NOT NULL CHECK(duration_days >= 0),
      predecessors_json TEXT NOT NULL DEFAULT '[]',
      planned_start TEXT,
      actual_start TEXT,
      actual_finish TEXT,
      percent_complete INTEGER NOT NULL DEFAULT 0 CHECK(percent_complete BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','blocked')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_schedule_project ON ai_schedule_tasks(project_id,created_at);
    CREATE TABLE IF NOT EXISTS ai_project_risks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      risk_code TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      description TEXT NOT NULL,
      probability INTEGER NOT NULL CHECK(probability BETWEEN 1 AND 5),
      impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 5),
      mitigation TEXT NOT NULL DEFAULT '',
      owner_name TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','mitigating','accepted','closed')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_risks_project ON ai_project_risks(project_id,status);
    CREATE TABLE IF NOT EXISTS ai_contract_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      event_code TEXT,
      title TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'general',
      fidic_clause TEXT,
      notice_date TEXT,
      event_date TEXT,
      particulars TEXT NOT NULL,
      time_impact_days INTEGER NOT NULL DEFAULT 0 CHECK(time_impact_days >= 0),
      cost_impact REAL NOT NULL DEFAULT 0 CHECK(cost_impact >= 0),
      currency TEXT NOT NULL DEFAULT 'JOD',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','notice_sent','submitted','under_review','agreed','rejected','closed')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_contract_events_project ON ai_contract_events(project_id,status);
    CREATE TABLE IF NOT EXISTS ai_bim_issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
      issue_code TEXT,
      model_reference TEXT,
      discipline TEXT NOT NULL DEFAULT 'general',
      issue_type TEXT NOT NULL DEFAULT 'coordination',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location_reference TEXT,
      element_ids_json TEXT NOT NULL DEFAULT '[]',
      severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low','medium','high','critical')),
      proposed_resolution TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','in_review','resolved','closed')),
      assigned_to TEXT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ai_bim_issues_project ON ai_bim_issues(project_id,status,severity);
  `);
}

function migrate(dbPath = config.DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const ins = db.prepare(`
    INSERT INTO plans (key, name_ar, name_en, max_tenders, max_bytes, price_month, price_year, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      name_ar=excluded.name_ar, name_en=excluded.name_en,
      max_tenders=excluded.max_tenders, max_bytes=excluded.max_bytes,
      price_month=excluded.price_month, price_year=excluded.price_year,
      sort_order=excluded.sort_order`);
  const tx = db.transaction((rows) => rows.forEach((r) => ins.run(...r)));
  tx(PLANS_SEED);

  upgradeProcurement(db);
  upgradePlans(db);
  upgradeOrg(db);
  upgradeBilingual(db);
  upgradeWorkflow(db);
  upgradeProjectFinance(db);
  upgradeTenderOpportunities(db);
  upgradeTenderOpportunityDocuments(db);
  upgradeMultiCountry(db);
  upgradeOpportunitySyncRuns(db);
  upgradeV5(db);
  upgradeBidSubmissionDocuments(db);
  upgradeCommitteeAndMail(db);
  upgradeEInvoice(db);
  upgradeOpportunityWatch(db);
  upgradeConsultingPortal(db);
  upgradeConsultingFirmDocuments(db);
  upgradeConsultingOfficeTendering(db);
  upgradeConsultingOfficeOperations(db);
  upgradeConsultingOfficeTenderDocuments(db);
  upgradeConsultingMarketplace(db);
  upgradeConsultingContractTracking(db);
  upgradeMmcAiProjects(db);

  return db;
}

/** يُشغَّل مباشرة: node src/migrate.js */
if (require.main === module) {
  const db = migrate();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const plans = db.prepare('SELECT key, max_tenders, max_bytes, price_month FROM plans ORDER BY sort_order').all();
  console.log('[migrate] قاعدة البيانات:', config.DB_PATH);
  console.log('[migrate] الجداول:', tables.map((t) => t.name).join(', '));
  console.log('[migrate] الباقات:');
  plans.forEach((p) => console.log('   ', p.key, '| عطاءات:', p.max_tenders === -1 ? 'غير محدود' : p.max_tenders,
    '| حجم:', p.max_bytes === -1 ? 'غير محدود' : (p.max_bytes / 1048576) + ' MB', '| $' + p.price_month + '/شهر'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all();
  console.log('[migrate] الفهارس:', idx.map((i) => i.name).join(', '));
  console.log('[migrate] تم بنجاح.');
  db.close();
}

module.exports = { migrate, PLANS_SEED, SCHEMA, TRIAL_DAYS };
