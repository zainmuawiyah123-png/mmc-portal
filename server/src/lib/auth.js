'use strict';
/**
 * المصادقة: bcrypt لتشفير كلمة المرور، JWT في httpOnly cookie للجلسة،
 * وحُرّاس ملكية (ownership guards) لكل مورد.
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDB } = require('../db');
const { E } = require('./errors');

const hashPassword = (plain) => bcrypt.hash(plain, config.BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.JWT_SECRET, {
    expiresIn: config.JWT_TTL,
    issuer: 'tpkit-portal'
  });
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET, { issuer: 'tpkit-portal' });
}

function setSessionCookie(res, token) {
  res.cookie(config.COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: config.CORS_ORIGIN ? 'none' : 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.COOKIE_NAME, { path: '/' });
}

/** يقرأ التوكن من الكوكي، أو من Authorization: Bearer كبديل للاختبار بأدوات سطر الأوامر */
function extractToken(req) {
  if (req.cookies && req.cookies[config.COOKIE_NAME]) return req.cookies[config.COOKIE_NAME];
  const h = req.get('authorization');
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function loadUser(id) {
  return getDB().prepare(
    'SELECT id, email, name, company, role, country, plan_key, plan_started_at, created_at, last_login_at FROM users WHERE id = ?'
  ).get(id);
}

/** middleware: يفرض وجود جلسة صالحة */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(E.unauthorized());
  try {
    const payload = verifyToken(token);
    const user = loadUser(payload.sub);
    if (!user) return next(E.unauthorized('الجلسة لم تعد صالحة. سجّل الدخول من جديد.'));
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(E.unauthorized('انتهت صلاحية الجلسة. سجّل الدخول من جديد.'));
    return next(E.unauthorized('جلسة غير صالحة. سجّل الدخول من جديد.'));
  }
}

/**
 * يجلب عطاءً ويتحقق أن المستخدم يملكه فعلاً.
 * يُرجع 404 (لا 403) لعطاء مستخدم آخر حتى لا يُكشف وجود المعرّف.
 */
function ownTender(req, tenderId) {
  const row = getDB().prepare('SELECT * FROM tenders WHERE id = ?').get(tenderId);
  if (!row) throw E.notFound('العطاء غير موجود.');
  if (row.user_id !== req.user.id) throw E.notFound('العطاء غير موجود.');
  return row;
}

/** نفس المنطق للملفات */
function ownFile(req, fileId) {
  const row = getDB().prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  if (!row) throw E.notFound('الملف غير موجود.');
  if (row.user_id !== req.user.id) throw E.notFound('الملف غير موجود.');
  return row;
}

/** ملخص الباقة + الاستهلاك الفعلي */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(E.forbidden('لا تملك صلاحية استخدام هذه البوابة.'));
    next();
  };
}

/** يعيد المستخدم للباقة المجانية فوراً إذا انتهى اشتراكه (دون انتظار المهمة المجدولة) */
function expireIfDue(userId) {
  const db = getDB();
  const now = Math.floor(Date.now() / 1000);
  const u = db.prepare('SELECT plan_key FROM users WHERE id = ?').get(userId);
  if (!u || u.plan_key === 'free') return;
  db.prepare("UPDATE subscriptions SET status='expired' WHERE user_id=? AND status='active' AND ends_at IS NOT NULL AND ends_at <= ?").run(userId, now);
  const live = db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND status='active' AND plan_key=?").get(userId, u.plan_key);
  if (!live) db.prepare("UPDATE users SET plan_key='free', plan_started_at=? WHERE id=?").run(now, userId);
}

function planAndUsage(userId) {
  expireIfDue(userId);
  const db = getDB();
  const user = db.prepare('SELECT plan_key FROM users WHERE id = ?').get(userId);
  const planKey = user ? user.plan_key : 'free';
  const plan = db.prepare('SELECT * FROM plans WHERE key = ?').get(planKey) || db.prepare("SELECT * FROM plans WHERE key='free'").get();

  const tenderCount = db.prepare('SELECT COUNT(*) AS n FROM tenders WHERE user_id = ?').get(userId).n;
  const agg = db.prepare(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM files WHERE user_id = ?'
  ).get(userId);
  const ready = db.prepare("SELECT COUNT(*) AS n FROM tenders WHERE user_id = ? AND status = 'ready'").get(userId).n;
  const proc = db.prepare("SELECT COUNT(*) AS n FROM tenders WHERE user_id = ? AND status = 'proc'").get(userId).n;

  const subsUsed = db.prepare('SELECT COUNT(*) AS n FROM bid_submissions WHERE contractor_id = ? AND submitted_at >= ?')
    .get(userId, Math.floor(Date.now() / 1000) - 365 * 86400).n;
  const unlimS = plan.max_submissions === -1;
  const unlimT = plan.max_tenders === -1;
  const unlimB = plan.max_bytes === -1;

  const sub = db.prepare("SELECT source, ends_at FROM subscriptions WHERE user_id=? AND status='active' AND plan_key=? ORDER BY started_at DESC LIMIT 1").get(userId, plan.key);
  return {
    subscription: sub ? { source: sub.source, endsAt: sub.ends_at } : null,
    plan: {
      key: plan.key, nameAr: plan.name_ar, nameEn: plan.name_en,
      audience: plan.audience, maxUsers: plan.max_users === -1 ? null : plan.max_users,
      maxTenders: unlimT ? null : plan.max_tenders,
      maxSubmissions: unlimS ? null : plan.max_submissions,
      maxBytes: unlimB ? null : plan.max_bytes,
      priceMonth: plan.price_month, priceYear: plan.price_year
    },
    usage: {
      tenders: tenderCount,
      tendersMax: unlimT ? null : plan.max_tenders,
      tendersPct: unlimT ? null : Math.min(100, Math.round((tenderCount / plan.max_tenders) * 100)),
      bytes: agg.bytes,
      bytesMax: unlimB ? null : plan.max_bytes,
      bytesPct: unlimB ? null : Math.min(100, Math.round((agg.bytes / plan.max_bytes) * 100)),
      files: agg.files,
      submissions: subsUsed, submissionsMax: unlimS ? null : plan.max_submissions,
      ready, processing: proc
    }
  };
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken,
  setSessionCookie, clearSessionCookie, extractToken,
  requireAuth, requireRole, ownTender, ownFile, loadUser, planAndUsage, expireIfDue
};
