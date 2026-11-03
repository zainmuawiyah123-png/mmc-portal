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
  // باقات المشتريات (الأسعار بالدولار؛ السنوي = 10 أشهر. سعر Enterprise "ابتداءً من" ويعدّله المدير لكل حالة)
  ['proc_basic', 'المشتريات Basic',        'Procurement Basic',        10, 2 * 1024 * 1024 * 1024,  49,  490, 5],
  ['proc_pro',   'المشتريات Professional', 'Procurement Professional', -1, 10 * 1024 * 1024 * 1024, 149, 1490, 6],
  ['proc_ent',   'المشتريات Enterprise',   'Procurement Enterprise',   -1, -1,                      399, 3990, 7]
];
// عدد المستخدمين المسموح (-1 = غير محدود) — للعرض حالياً؛ لا يوجد نموذج منظمة/مقاعد بعد
const PLAN_SEATS = { free: 1, starter: 1, pro: 10, ent: -1, proc_basic: 3, proc_pro: 10, proc_ent: -1 };
// عدد التقديمات الإلكترونية على عطاءات المنصة خلال 365 يوماً (-1 = غير محدود). حدّ مساحة العمل (max_tenders) منفصل عنه
const PLAN_SUBMISSIONS = { free: 2, starter: 10, pro: 40, ent: -1, proc_basic: -1, proc_pro: -1, proc_ent: -1 };
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
  db.prepare("UPDATE plans SET audience='buyer', trial_days=? WHERE key LIKE 'proc\\_%' ESCAPE '\\'").run(TRIAL_DAYS);
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
  upgradeV5(db);

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
