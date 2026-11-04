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

function upgradePlans(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name));
  const addedAudience = !cols.has('audience');
  const addedMaxUsers = !cols.has('max_users');
  const addedTrialDays = !cols.has('trial_days');
  if (addedAudience) db.exec("ALTER TABLE plans ADD COLUMN audience TEXT NOT NULL DEFAULT 'contractor'");
  if (addedMaxUsers) db.exec('ALTER TABLE plans ADD COLUMN max_users INTEGER NOT NULL DEFAULT 1');
  if (addedTrialDays) db.exec('ALTER TABLE plans ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 0');

  // Backfill only when each column is first introduced. Re-running startup
  // migrations must never overwrite plan settings edited by an administrator.
  if (addedAudience || addedTrialDays) {
    const sets = [];
    if (addedAudience) sets.push("audience='buyer'");
    if (addedTrialDays) sets.push('trial_days=' + TRIAL_DAYS);
    db.exec("UPDATE plans SET " + sets.join(', ') + " WHERE key LIKE 'proc\\_%' ESCAPE '\\'");
  }
  if (addedMaxUsers) {
    const up = db.prepare('UPDATE plans SET max_users=? WHERE key=?');
    Object.entries(PLAN_SEATS).forEach(([k, v]) => up.run(v, k));
  }
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


function upgradePublicTenderIntelligence(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tender_sources (
      source_key TEXT PRIMARY KEY,
      name_ar TEXT NOT NULL,
      name_en TEXT NOT NULL,
      country_code TEXT,
      market_scope TEXT NOT NULL,
      publisher_type TEXT NOT NULL,
      organization_family TEXT,
      source_url TEXT NOT NULL,
      connector_status TEXT NOT NULL DEFAULT 'planned',
      access_mode TEXT,
      last_synced_at INTEGER,
      last_sync_status TEXT,
      last_sync_message TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS public_tenders (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL REFERENCES tender_sources(source_key),
      source_ref TEXT NOT NULL,
      country_code TEXT,
      market_scope TEXT NOT NULL,
      publisher_type TEXT NOT NULL,
      organization_family TEXT,
      publisher_name TEXT NOT NULL,
      tender_number TEXT,
      title TEXT NOT NULL,
      description TEXT,
      category_key TEXT,
      tender_type TEXT,
      published_at TEXT,
      purchase_deadline TEXT,
      closing_at TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      currency TEXT,
      estimated_value REAL,
      bid_bond TEXT,
      document_fee TEXT,
      qualification TEXT,
      official_url TEXT NOT NULL,
      content_hash TEXT,
      source_updated_at TEXT,
      last_verified_at INTEGER,
      fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
      review_status TEXT NOT NULL DEFAULT 'needs-review',
      raw_metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(source_key, source_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_public_tenders_country ON public_tenders(country_code, status, closing_at);
    CREATE INDEX IF NOT EXISTS idx_public_tenders_market ON public_tenders(market_scope, publisher_type);
    CREATE INDEX IF NOT EXISTS idx_public_tenders_category ON public_tenders(category_key, status);
    CREATE INDEX IF NOT EXISTS idx_public_tenders_closing ON public_tenders(closing_at);
    CREATE INDEX IF NOT EXISTS idx_public_tenders_search ON public_tenders(title, tender_number, publisher_name);
    CREATE TABLE IF NOT EXISTS public_tender_documents (
      id TEXT PRIMARY KEY,
      public_tender_id TEXT NOT NULL REFERENCES public_tenders(id) ON DELETE CASCADE,
      source_document_ref TEXT,
      label TEXT NOT NULL,
      document_url TEXT NOT NULL,
      mime_type TEXT,
      availability TEXT NOT NULL DEFAULT 'source-link',
      storage_key TEXT,
      checksum_sha256 TEXT,
      fetched_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(public_tender_id, document_url)
    );
    CREATE INDEX IF NOT EXISTS idx_public_tender_docs_tender ON public_tender_documents(public_tender_id);
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
    ON CONFLICT(key) DO NOTHING`);
  const tx = db.transaction((rows) => rows.forEach((r) => ins.run(...r)));
  tx(PLANS_SEED);

  upgradeProcurement(db);
  upgradePlans(db);
  upgradeV5(db);
  upgradePublicTenderIntelligence(db);

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

module.exports = { migrate, PLANS_SEED, SCHEMA, TRIAL_DAYS, upgradePublicTenderIntelligence };
