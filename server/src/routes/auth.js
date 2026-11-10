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
    role: u.role || 'contractor', country: u.country || 'JO', planKey: u.role === 'buyer' ? 'free' : u.plan_key, createdAt: u.created_at, lastLoginAt: u.last_login_at
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

  db.prepare(`INSERT INTO users (id, email, password_hash, name, company, role, country, plan_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'free')`).run(id, body.email, hash, body.name, body.company, body.role || 'contractor', body.country);

  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_key, status, source)
              VALUES (?, ?, 'free', 'active', ?)`).run(uid('sub_'), id, body.role === 'buyer' ? 'system' : 'trial');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  A.setSessionCookie(res, A.signToken(user));

  res.status(201).json({
    user: publicUser(user),
    plan: A.planAndUsage(id),
    message: body.role === 'buyer' ? 'تم إنشاء حساب الجهة. بوابة المشتريات الأساسية مجانية بالكامل.' : 'تم إنشاء الحساب. أنت الآن على الباقة المجانية.'
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

module.exports = router;
