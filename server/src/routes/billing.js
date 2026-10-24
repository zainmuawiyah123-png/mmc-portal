'use strict';
/**
 * Billing / invoices and bank-transfer receipts.
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const S = require('../lib/storage');
const { audit } = require('../lib/audit');

const router = express.Router();
const auth = A.requireAuth;
const admin = [auth, A.requireRole('admin')];
const RECEIPT_MAX_BYTES = Math.min(config.MAX_FILE_BYTES, 10 * 1024 * 1024);
const RECEIPT_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = S.safeExt(file.originalname);
    if (!RECEIPT_EXTS.has(ext)) return cb(E.unsupported('إيصال التحويل يجب أن يكون PDF أو JPG أو PNG أو WEBP.'));
    try { S.assertAllowed(file.originalname, 0); cb(null, true); } catch (err) { cb(err); }
  }
});

function invoiceNumber() {
  const d = new Date();
  return `MMC-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function shapeInvoice(row) {
  return {
    id: row.id, invoiceNumber: row.invoice_number, userId: row.user_id,
    customerName: row.customer_name || null, customerEmail: row.customer_email || null,
    customerCompany: row.customer_company || null, planKey: row.plan_key,
    billingCycle: row.billing_cycle, currency: row.currency, amount: row.amount,
    status: row.status, paymentMethod: row.payment_method,
    transferReference: row.transfer_reference, transferDate: row.transfer_date,
    receiptName: row.receipt_original_name || null, receiptUploadedAt: row.receipt_uploaded_at || null,
    paidAt: row.paid_at || null, dueAt: row.due_at || null, notes: row.notes || null,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function invoiceQuery(where = '', params = []) {
  return getDB().prepare(`SELECT i.*, u.name customer_name, u.email customer_email, u.company customer_company
    FROM invoices i JOIN users u ON u.id=i.user_id ${where} ORDER BY i.created_at DESC`).all(...params);
}
function ownInvoice(req, id) {
  const row = invoiceQuery('WHERE i.id = ? AND i.user_id = ?', [id, req.user.id])[0];
  if (!row) throw E.notFound('الفاتورة غير موجودة.');
  return row;
}

function audienceFor(user) { return user.role === 'buyer' ? 'buyer' : 'contractor'; }
function shapePlan(p) {
  return { key: p.key, nameAr: p.name_ar, nameEn: p.name_en, audience: p.audience,
    maxTenders: p.max_tenders === -1 ? null : p.max_tenders, maxUsers: p.max_users === -1 ? null : p.max_users,
    priceMonth: p.price_month, priceYear: p.price_year, trialDays: p.trial_days || 0 };
}

/* الباقات المتاحة (عامة) — ?audience=buyer|contractor */
router.get('/plans', wrap(async (req, res) => {
  const aud = req.query.audience === 'buyer' ? 'buyer' : 'contractor';
  const rows = getDB().prepare("SELECT * FROM plans WHERE audience = ? AND key != 'free' ORDER BY sort_order").all(aud);
  res.json({ plans: rows.map(shapePlan) });
}));

/* تجربة مجانية لمرة واحدة لكل مستخدم على باقة مشتريات */
router.post('/trial', auth, wrap(async (req, res) => {
  const db = getDB();
  const plan = db.prepare('SELECT * FROM plans WHERE key = ?').get(String(req.body?.planKey || ''));
  if (!plan || plan.trial_days <= 0) throw E.validation('هذه الباقة لا تدعم التجربة المجانية.');
  if (plan.audience !== audienceFor(req.user)) throw E.forbidden('هذه الباقة غير مخصصة لنوع حسابك.');
  const used = db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND source='trial' AND plan_key LIKE 'proc\\_%' ESCAPE '\\'").get(req.user.id);
  if (used) throw E.conflict('استخدمت التجربة المجانية سابقاً. أنشئ فاتورة لتفعيل الباقة.');
  const now = Math.floor(Date.now() / 1000);
  const ends = now + plan.trial_days * 86400;
  db.transaction(() => {
    db.prepare("UPDATE subscriptions SET status='cancelled' WHERE user_id=? AND status='active'").run(req.user.id);
    db.prepare('UPDATE users SET plan_key=?, plan_started_at=? WHERE id=?').run(plan.key, now, req.user.id);
    db.prepare('INSERT INTO subscriptions (id,user_id,plan_key,status,source,started_at,ends_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid('sub_'), req.user.id, plan.key, 'active', 'trial', now, ends);
  })();
  audit({ action: 'trial_start', entity: 'subscription', entityId: req.user.id, userId: req.user.id, ip: req.ip, detail: { plan: plan.key, endsAt: ends } });
  res.status(201).json({ planKey: plan.key, endsAt: ends, message: 'بدأت تجربتك المجانية لمدة ' + plan.trial_days + ' يوماً.' });
}));

/* Contractor: create and view invoices */
router.post('/invoices', auth, wrap(async (req, res) => {
  const body = req.body || {};
  const planKey = String(body.planKey || '');
  const billingCycle = body.billingCycle === 'annual' ? 'annual' : 'monthly';
  const currency = String(body.currency || 'USD').toUpperCase();
  const paymentMethod = ['bank_transfer', 'cliq'].includes(body.paymentMethod) ? body.paymentMethod : 'bank_transfer';
  if (!['JOD', 'USD', 'SAR', 'AED'].includes(currency)) throw E.validation('العملة غير مدعومة.');
  const db = getDB();
  const plan = db.prepare("SELECT * FROM plans WHERE key = ? AND key != 'free'").get(planKey);
  if (!plan) throw E.validation('اختر باقة مدفوعة صالحة.');
  if (req.user.role !== 'admin' && plan.audience !== audienceFor(req.user)) throw E.forbidden('هذه الباقة غير مخصصة لنوع حسابك.');
  const amount = billingCycle === 'annual' ? plan.price_year : plan.price_month;
  const id = uid('inv_');
  db.prepare(`INSERT INTO invoices (id,invoice_number,user_id,plan_key,billing_cycle,currency,amount,status,payment_method,due_at,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, invoiceNumber(), req.user.id, planKey, billingCycle, currency, amount,
    'pending', paymentMethod, Math.floor(Date.now() / 1000) + 7 * 86400, String(body.notes || '').slice(0, 1000) || null);
  res.status(201).json({ invoice: shapeInvoice(invoiceQuery('WHERE i.id=?', [id])[0]), message: 'تم إنشاء الفاتورة. ارفع إيصال التحويل لإكمال الطلب.' });
}));
router.get('/invoices', auth, wrap(async (req, res) => {
  const rows = invoiceQuery('WHERE i.user_id=?', [req.user.id]);
  res.json({ invoices: rows.map(shapeInvoice), count: rows.length });
}));
router.get('/invoices/:id', auth, wrap(async (req, res) => {
  res.json({ invoice: shapeInvoice(ownInvoice(req, req.params.id)) });
}));
router.post('/invoices/:id/receipt', auth, receiptUpload.single('receipt'), wrap(async (req, res) => {
  const invoice = ownInvoice(req, req.params.id);
  if (!['pending', 'rejected'].includes(invoice.status)) throw E.conflict('لا يمكن رفع إيصال لفاتورة حالتها الحالية: ' + invoice.status);
  if (!req.file) throw E.badRequest('أرفق ملف الإيصال في الحقل receipt.');
  const store = S.getStorage();
  const key = `users/${req.user.id}/invoices/${invoice.id}/${S.makeStoredName(req.file.originalname)}`;
  const put = await store.put(key, req.file.buffer, { mime: req.file.mimetype, originalName: S.displayName(req.file.originalname) });
  const db = getDB();
  db.prepare(`UPDATE invoices SET receipt_storage_key=?, receipt_storage_driver=?, receipt_original_name=?, receipt_mime=?,
    receipt_size=?, receipt_checksum_sha256=?, receipt_uploaded_at=unixepoch(), status='pending', updated_at=unixepoch() WHERE id=?`)
    .run(key, store.DRIVER, S.displayName(req.file.originalname), req.file.mimetype, req.file.size, put.checksum, invoice.id);
  audit({ action: 'upload', entity: 'invoice_receipt', entityId: invoice.id, userId: req.user.id, driver: store.DRIVER, ip: req.ip, detail: { key, size: req.file.size, checksum: put.checksum } });
  res.status(201).json({ invoice: shapeInvoice(invoiceQuery('WHERE i.id=?', [invoice.id])[0]), message: 'تم رفع الإيصال وباتت الفاتورة بانتظار مراجعة الإدارة.' });
}));

/* Admin: review, download, approve and reject */
router.get('/admin/invoices', admin, wrap(async (req, res) => {
  const status = String(req.query.status || '').trim();
  const rows = invoiceQuery(status ? 'WHERE i.status=?' : '', status ? [status] : []);
  res.json({ invoices: rows.map(shapeInvoice), count: rows.length });
}));
router.get('/admin/invoices/:id/receipt', admin, wrap(async (req, res) => {
  const row = getDB().prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row || !row.receipt_storage_key) throw E.notFound('إيصال التحويل غير موجود.');
  const driver = row.receipt_storage_driver || 'local';
  const store = driver === 's3' ? require('../lib/storage/s3') : require('../lib/storage/local');
  if (!(await store.exists(row.receipt_storage_key))) throw E.notFound('ملف الإيصال غير موجود في التخزين.');
  res.setHeader('Content-Type', row.receipt_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(row.receipt_original_name || 'receipt') + '"');
  res.setHeader('Cache-Control', 'private, no-store');
  store.stream(row.receipt_storage_key).pipe(res);
}));
/* سعر خاص لكل حالة: يعدّل المدير مبلغ/عملة فاتورة معلّقة قبل الاعتماد */
router.post('/admin/invoices/:id/amount', admin, wrap(async (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) throw E.notFound('الفاتورة غير موجودة.');
  if (row.status !== 'pending') throw E.conflict('يمكن تعديل المبلغ للفواتير المعلّقة فقط.');
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) throw E.validation('أدخل مبلغاً صحيحاً.');
  const currency = String(req.body?.currency || row.currency).toUpperCase();
  if (!['JOD', 'USD', 'SAR', 'AED'].includes(currency)) throw E.validation('العملة غير مدعومة.');
  db.prepare('UPDATE invoices SET amount=?, currency=?, updated_at=unixepoch() WHERE id=?').run(amount, currency, row.id);
  audit({ action: 'billing_custom_price', entity: 'invoice', entityId: row.id, userId: req.user.id, ip: req.ip, detail: { from: row.amount, to: amount, currency } });
  res.json({ ok: true, amount, currency, message: 'تم تحديد السعر الخاص لهذه الفاتورة.' });
}));
router.post('/admin/invoices/:id/reject', admin, wrap(async (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) throw E.notFound('الفاتورة غير موجودة.');
  if (row.status === 'paid') throw E.conflict('لا يمكن رفض فاتورة مدفوعة.');
  const reason = String(req.body?.reason || 'لم تتم مطابقة التحويل.').slice(0, 1000);
  db.prepare("UPDATE invoices SET status='rejected', notes=?, updated_at=unixepoch() WHERE id=?").run(reason, row.id);
  audit({ action: 'billing_reject', entity: 'invoice', entityId: row.id, userId: req.user.id, ip: req.ip, detail: { reason } });
  res.json({ ok: true, message: 'تم رفض الفاتورة وإبلاغ سبب الرفض.' });
}));
router.post('/admin/invoices/:id/approve', admin, wrap(async (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) throw E.notFound('الفاتورة غير موجودة.');
  if (row.status === 'paid') throw E.conflict('الفاتورة معتمدة مسبقاً.');
  if (!row.receipt_storage_key) throw E.conflict('لا يمكن الاعتماد قبل رفع إيصال التحويل.');
  const now = Math.floor(Date.now() / 1000);
  const days = row.billing_cycle === 'annual' ? 365 : 30;
  const ends = now + days * 86400;
  const tx = db.transaction(() => {
    db.prepare("UPDATE subscriptions SET status='cancelled' WHERE user_id=? AND status='active'").run(row.user_id);
    db.prepare("UPDATE users SET plan_key=?, plan_started_at=? WHERE id=?").run(row.plan_key, now, row.user_id);
    db.prepare("INSERT INTO subscriptions (id,user_id,plan_key,status,source,started_at,ends_at) VALUES (?,?,?,?,?,?,?)")
      .run(uid('sub_'), row.user_id, row.plan_key, 'active', 'manual', now, ends);
    db.prepare("UPDATE invoices SET status='paid', paid_at=?, updated_at=unixepoch() WHERE id=?").run(now, row.id);
  });
  tx();
  audit({ action: 'billing_approve', entity: 'invoice', entityId: row.id, userId: req.user.id, ip: req.ip, detail: { customerId: row.user_id, plan: row.plan_key, endsAt: ends } });
  res.json({ ok: true, planKey: row.plan_key, startsAt: now, endsAt: ends, message: 'تم اعتماد التحويل وتفعيل الباقة للمستخدم.' });
}));

module.exports = router;
