'use strict';
/**
 * نقاط المصادقة: تسجيل، دخول، خروج، بياناتي.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const { registerSchema, loginSchema, parse } = require('../lib/validate');
const A = require('../lib/auth');
const O = require('../lib/org');
const { audit } = require('../lib/audit');
const mailer = require('../lib/mailer');

const OTP_TTL_SECONDS = 10 * 60;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
function otpHash(userId, code) {
  return crypto.createHmac('sha256', config.JWT_SECRET).update(userId + ':' + code).digest('hex');
}
function issueOtp(db, user) {
  const now = Math.floor(Date.now() / 1000);
  const previous = db.prepare('SELECT last_sent_at FROM email_verifications WHERE user_id=?').get(user.id);
  if (previous && now - previous.last_sent_at < OTP_RESEND_SECONDS) {
    throw E.rateLimited('انتظر دقيقة قبل طلب رمز جديد.');
  }
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO email_verifications (user_id,email,code_hash,expires_at,attempts,last_sent_at,verified_at)
    VALUES (?,?,?,?,0,?,NULL) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at,verified_at=NULL`)
    .run(user.id, user.email, otpHash(user.id, code), now + OTP_TTL_SECONDS, now);
  return mailer.notifyNow(user.email, 'رمز تأكيد البريد الإلكتروني - MMC',
    'رمز تأكيد بريدك الإلكتروني في MMC هو: ' + code + '\\n\\nصلاحية الرمز 10 دقائق. لا تشارك هذا الرمز مع أي شخص.')
    .then((result) => {
      if (!result.sent) throw E.server('تعذّر إرسال رمز التحقق. تحقق من إعدادات البريد ثم أعد المحاولة.');
      return true;
    });
}

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
  if (!mailer.enabled()) throw E.server('خدمة البريد الإلكتروني غير مفعّلة على الخادم. لا يمكن إكمال التسجيل قبل تفعيل إرسال البريد.');

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email);
  if (exists) throw E.conflict('هذا البريد مسجّل بالفعل. سجّل الدخول بدلاً من إنشاء حساب جديد.');

  const id = uid('usr_');
  const hash = await A.hashPassword(body.password);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO users (id, email, password_hash, name, company, role, country, plan_key, account_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'free', 'pending')`).run(id, body.email, hash, body.name, body.company, body.role || 'contractor', body.country);
    db.prepare(`INSERT INTO subscriptions (id, user_id, plan_key, status, source)
                VALUES (?, ?, 'free', 'active', ?)`).run(uid('sub_'), id, ['buyer','consultant'].includes(body.role) ? 'system' : 'trial');
  });
  tx();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  try {
    await issueOtp(db, user);
  } catch (err) {
    // Keep the pending account so a transient SMTP failure can be retried via resend.
    throw err;
  }
  res.status(201).json({
    verificationRequired: true, email: user.email,
    message: 'أرسلنا رمز التحقق إلى بريد العمل. أكّد البريد أولاً، ثم ينتقل الحساب إلى مراجعة MMC.'
  });
}));

/* ---------------- POST /api/auth/verify-email ---------------- */
router.post('/verify-email', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || !/^\\d{6}$/.test(code)) throw E.validation('أدخل البريد ورمز التحقق المكوّن من 6 أرقام.');
  const db = getDB();
  const user = db.prepare('SELECT id,email FROM users WHERE email=?').get(email);
  if (!user) throw E.notFound('طلب التسجيل غير موجود.');
  const row = db.prepare('SELECT * FROM email_verifications WHERE user_id=?').get(user.id);
  if (!row || row.verified_at) throw E.conflict('لا يوجد رمز تحقق نشط لهذا البريد.');
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) throw E.conflict('انتهت صلاحية الرمز. اطلب رمزاً جديداً.');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw E.rateLimited('تجاوزت عدد المحاولات. اطلب رمزاً جديداً بعد دقيقة.');
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(otpHash(user.id, code), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    db.prepare('UPDATE email_verifications SET attempts=attempts+1 WHERE user_id=?').run(user.id);
    throw E.validation('رمز التحقق غير صحيح.');
  }
  db.prepare('UPDATE email_verifications SET verified_at=? WHERE user_id=?').run(now, user.id);
  res.json({ verified: true, accountStatus: 'pending', message: 'تم تأكيد البريد الإلكتروني. طلبك الآن بانتظار مراجعة واعتماد MMC.' });
}));

/* ---------------- POST /api/auth/resend-verification ---------------- */
router.post('/resend-verification', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw E.validation('أدخل بريداً إلكترونياً صحيحاً.');
  if (!mailer.enabled()) throw E.server('خدمة البريد الإلكتروني غير مفعّلة على الخادم.');
  const db = getDB();
  const user = db.prepare('SELECT id,email FROM users WHERE email=?').get(email);
  if (!user) throw E.notFound('طلب التسجيل غير موجود.');
  const row = db.prepare('SELECT verified_at FROM email_verifications WHERE user_id=?').get(user.id);
  if (!row || row.verified_at) throw E.conflict('لا يوجد طلب تحقق معلّق لهذا البريد.');
  await issueOtp(db, user);
  res.json({ sent: true, message: 'تم إرسال رمز تحقق جديد إلى بريدك.' });
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
  const emailVerification = db.prepare('SELECT verified_at FROM email_verifications WHERE user_id=?').get(user.id);
  if (emailVerification && !emailVerification.verified_at) {
    throw E.forbidden('يجب تأكيد البريد الإلكتروني أولاً. أدخل رمز التحقق المرسل إلى بريد العمل.');
  }
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
