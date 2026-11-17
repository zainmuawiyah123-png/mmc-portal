'use strict';
/**
 * نقاط المصادقة: تسجيل، دخول، خروج، بياناتي.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const { registerSchema, loginSchema, parse } = require('../lib/validate');
const A = require('../lib/auth');
const O = require('../lib/org');
const { audit } = require('../lib/audit');

const router = express.Router();

/** حد المحاولات على تسجيل الدخول — 10 محاولات لكل IP كل 15 دقيقة */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'محاولات دخول كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم أعد المحاولة.'
      }
    });
  }
});

/** حد إنشاء الحسابات — 5 حسابات لكل IP كل ساعة */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res) => {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'عدد كبير من إنشاء الحسابات. حاول لاحقاً.' }
    });
  }
});

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, company: u.company,
    role: u.role || 'contractor', accountStatus: u.account_status || 'active', country: u.country || 'JO', planKey: u.role === 'buyer' ? 'free' : u.plan_key, createdAt: u.created_at, lastLoginAt: u.last_login_at
  };
}

/* ---------------- POST /api/auth/register ---------------- */
router.post('/register', registerLimiter, wrap(async (req, res) => {
  const body = parse(registerSchema, req.body);
  const db = getDB();

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email);
  if (exists) throw E.conflict('هذا البريد مسجّل بالفعل. سجّل الدخول بدلاً من إنشاء حساب جديد.');

  const id = uid('usr_');
  const hash = await A.hashPassword(body.password);

  db.prepare(`INSERT INTO users (id, email, password_hash, name, company, role, country, plan_key, account_status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'free', 'pending')`).run(id, body.email, hash, body.name, body.company, body.role || 'contractor', body.country);

  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_key, status, source)
              VALUES (?, ?, 'free', 'active', ?)`).run(uid('sub_'), id, ['buyer','consultant'].includes(body.role) ? 'system' : 'trial');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({
    user: publicUser(user),
    accountStatus: 'pending',
    message: 'تم استلام طلب التسجيل. سيُراجع فريق MMC بيانات الشركة ونوع الحساب قبل تفعيل الدخول. مشاهدة البوابات العامة لا تتطلب حساباً.'
  });
}));

/* ---------------- POST /api/auth/login ---------------- */
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const body = parse(loginSchema, req.body);
  const db = getDB();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email);

  // نفس الرسالة في الحالتين — لا نكشف إن كان البريد مسجلاً
  const generic = E.unauthorized('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
  if (!user) {
    // مقارنة وهمية لموازنة التوقيت
    await A.verifyPassword(body.password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    throw generic;
  }
  const ok = await A.verifyPassword(body.password, user.password_hash);
  if (!ok) throw generic;
  if ((user.account_status || 'active') !== 'active') {
    const statusMessage = user.account_status === 'pending' ? 'حسابك قيد مراجعة MMC. ستتمكن من تسجيل الدخول بعد اعتماد بيانات الشركة.' : user.account_status === 'rejected' ? 'لم تتم الموافقة على طلب الحساب. يرجى التواصل مع إدارة MMC.' : 'تم إيقاف هذا الحساب. يرجى التواصل مع إدارة MMC.';
    throw E.forbidden(statusMessage);
  }

  db.prepare('UPDATE users SET last_login_at = unixepoch() WHERE id = ?').run(user.id);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  A.setSessionCookie(res, A.signToken(fresh));

  res.json({ user: publicUser(fresh), plan: A.planAndUsage(O.billingUserId(fresh)), message: 'تم تسجيل الدخول.' });
}));

/* ---------------- POST /api/auth/logout ---------------- */
router.post('/logout', wrap(async (req, res) => {
  A.clearSessionCookie(res);
  res.json({ ok: true, message: 'تم تسجيل الخروج.' });
}));

/* ---------------- GET /api/auth/me ---------------- */
router.get('/me', A.requireAuth, wrap(async (req, res) => {
  res.json({ user: publicUser(req.user), plan: A.planAndUsage(O.billingUserId(req.user)), org: req.user.role === 'buyer' ? (() => { const m = O.ensureOrg(req.user); return m ? { id: m.org_id, name: m.org_name, role: m.role } : null; })() : null });
}));

/* ---------------- PATCH /api/auth/me ---------------- */
router.patch('/me', A.requireAuth, wrap(async (req, res) => {
  const { name, company } = req.body || {};
  const db = getDB();
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2) throw E.validation('الاسم قصير جداً.');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim().slice(0, 120), req.user.id);
  }
  if (company !== undefined) {
    const c = company === null ? null : String(company).trim().slice(0, 160) || null;
    db.prepare('UPDATE users SET company = ? WHERE id = ?').run(c, req.user.id);
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(fresh), message: 'تم تحديث البيانات.' });
}));


/* إدارة طلبات الحسابات — التفعيل بعد مراجعة بيانات الشركة ونوع البوابة */
router.get('/admin/accounts', A.requireAuth, A.requireRole('admin'), wrap(async (req, res) => {
  const status = String(req.query.status || 'pending').trim();
  if (status && !['pending','active','rejected','suspended'].includes(status)) throw E.validation('حالة الحساب غير صالحة.');
  const rows = getDB().prepare(`
    SELECT id,email,name,company,role,country,account_status,account_status_note,created_at,account_reviewed_at
    FROM users ${status ? 'WHERE account_status=?' : ''}
    ORDER BY created_at DESC LIMIT 500
  `).all(...(status ? [status] : []));
  res.json({ accounts: rows, count: rows.length });
}));

router.patch('/admin/accounts/:id/status', A.requireAuth, A.requireRole('admin'), wrap(async (req, res) => {
  const status = String(req.body?.status || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!['active','rejected','suspended'].includes(status)) throw E.validation('الحالة الجديدة غير صالحة.');
  if (['rejected','suspended'].includes(status) && !note) throw E.validation('اكتب سبب الرفض أو الإيقاف.');
  const db = getDB();
  const target = db.prepare('SELECT id,role,account_status FROM users WHERE id=?').get(req.params.id);
  if (!target) throw E.notFound('الحساب غير موجود.');
  if (target.role === 'admin') throw E.forbidden('لا يمكن تغيير حالة حساب مدير المنصة من هذه الشاشة.');
  const now = Math.floor(Date.now()/1000);
  db.prepare('UPDATE users SET account_status=?,account_status_note=?,account_reviewed_by=?,account_reviewed_at=? WHERE id=?')
    .run(status, note || null, req.user.id, now, target.id);
  audit({action:'account_status_change',entity:'user',entityId:target.id,userId:req.user.id,ip:req.ip,detail:{from:target.account_status,to:status,note}});
  res.json({ok:true,status,message:status==='active'?'تم اعتماد الحساب ويمكنه تسجيل الدخول.':status==='rejected'?'تم رفض طلب الحساب.':'تم إيقاف الحساب.'});
}));

module.exports = router;
