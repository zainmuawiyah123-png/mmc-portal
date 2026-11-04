'use strict';
/**
 * اختبارات التكامل — node --test tests/
 * تشغّل الخادم على منفذ عشوائي بقاعدة بيانات مؤقتة، وتستخدم fetch الحقيقي.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------- بيئة اختبار معزولة (قبل أي require آخر) ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpkit-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.BCRYPT_ROUNDS = '4';      // أسرع في الاختبارات
process.env.PAYMENT_SWIFT = 'UBSIJOAXXXX';
process.env.PAYMENT_IBAN = 'JO07UBSI1220000330111332981002';
process.env.PAYMENT_ACCOUNT_HOLDER = 'MMC Test Account';

const { migrate } = require('../src/migrate');
const { createApp } = require('../src/index');
const { getDB, closeDB } = require('../src/db');

let server, base;
const cookies = {};   // مفتاح: اسم الجلسة → قيمة الكوكي

/* ---------------- helpers ---------------- */
function cookieFor(name) {
  return cookies[name] ? { Cookie: cookies[name] } : {};
}

async function call(name, method, p, { body, form, headers } = {}) {
  const h = Object.assign({}, cookieFor(name), headers || {});
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });

  // التقاط كوكي الجلسة
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookie) {
    const first = c.split(';')[0];
    if (first.startsWith('tpkit_session=')) {
      const val = first.split('=').slice(1).join('=');
      if (val === '' || /Max-Age=0/i.test(c)) delete cookies[name];
      else cookies[name] = first;
    }
  }

  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

function makeForm(files, extra = {}) {
  const fd = new FormData();
  for (const f of files) {
    fd.append('files', new Blob([f.content], { type: f.type || 'application/pdf' }), f.name);
  }
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

const uniq = () => Math.random().toString(36).slice(2, 9);

/* ---------------- setup / teardown ---------------- */
test.before(async () => {
  migrate(process.env.DB_PATH);
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ==========================================================
   1) الصحة والتسجيل
   ========================================================== */
test('01 — /api/health يستجيب', async () => {
  const r = await call('anon', 'GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
  // المرحلة الثانية: التخزين المجرّد + الجدولة + النسخ الاحتياطي
  assert.strictEqual(r.data.phase, 2);
  assert.ok(r.data.storage, 'يجب أن يعرض /api/health مشغّل التخزين');
  assert.ok(['local', 's3'].includes(r.data.storage.driver), 'مشغّل تخزين غير معروف: ' + r.data.storage.driver);
  assert.ok(r.data.scheduler, 'يجب أن يعرض /api/health حالة الجدولة');
});

test('02 — تسجيل مستخدم جديد يعيد 201 ويضبط الكوكي', async () => {
  const r = await call('userA', 'POST', '/api/auth/register', {
    body: { name: 'مستخدم أ', email: 'a' + uniq() + '@test.com', password: 'Password123', company: 'شركة أ' }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.user.id.startsWith('usr_'));
  assert.strictEqual(r.data.user.planKey, 'free');
  assert.ok(cookies.userA, 'يجب أن يُضبط كوكي الجلسة');
  assert.ok(!JSON.stringify(r.data).includes('password'), 'يجب ألا تُرجع كلمة المرور');
});

test('03 — تسجيل ببريد مكرر يُرفض 409', async () => {
  const email = 'dup' + uniq() + '@test.com';
  const a = await call('tmp1', 'POST', '/api/auth/register', { body: { name: 'أحمد', email, password: 'Password123' } });
  assert.strictEqual(a.status, 201);
  const b = await call('tmp2', 'POST', '/api/auth/register', { body: { name: 'بشار', email, password: 'Password123' } });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.data.error.code, 'CONFLICT');
});

test('04 — تسجيل ببيانات ناقصة يُرجع 422 مع تفاصيل الحقول', async () => {
  const r = await call('anon', 'POST', '/api/auth/register', { body: { name: 'x', email: 'not-an-email', password: '123' } });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.error.code, 'VALIDATION');
  assert.ok(Array.isArray(r.data.error.details) && r.data.error.details.length >= 2, 'يجب إرجاع تفاصيل لكل حقل');
});

test('05 — كلمة المرور مخزّنة bcrypt وليست نصاً صريحاً', async () => {
  const email = 'hash' + uniq() + '@test.com';
  const plain = 'SuperSecret123';
  const r = await call('hashU', 'POST', '/api/auth/register', { body: { name: 'اختبار التشفير', email, password: plain } });
  assert.strictEqual(r.status, 201);

  const row = getDB().prepare('SELECT password_hash FROM users WHERE email = ?').get(email);
  assert.notStrictEqual(row.password_hash, plain, 'كلمة المرور يجب ألا تُخزَّن نصاً');
  assert.ok(/^\$2[aby]\$/.test(row.password_hash), 'يجب أن تكون bcrypt hash: ' + row.password_hash.slice(0, 10));
  assert.ok(row.password_hash.length >= 59);
  assert.ok(!row.password_hash.includes(plain));

  const bcrypt = require('bcryptjs');
  assert.strictEqual(await bcrypt.compare(plain, row.password_hash), true, 'bcrypt يجب أن يطابق');
});

/* ==========================================================
   2) الدخول والخروج
   ========================================================== */
test('06 — دخول صحيح يعيد 200 وبيانات المستخدم', async () => {
  const email = 'login' + uniq() + '@test.com';
  await call('reg1', 'POST', '/api/auth/register', { body: { name: 'دخول', email, password: 'Password123' } });

  const r = await call('userB', 'POST', '/api/auth/login', { body: { email, password: 'Password123' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.email, email);
  assert.ok(cookies.userB);
});

test('07 — دخول بكلمة مرور خاطئة يُرفض 401', async () => {
  const email = 'wrong' + uniq() + '@test.com';
  await call('reg2', 'POST', '/api/auth/register', { body: { name: 'خطأ', email, password: 'Password123' } });
  const r = await call('anon', 'POST', '/api/auth/login', { body: { email, password: 'WrongPassword' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error.code, 'UNAUTHORIZED');
});

test('08 — دخول ببريد غير مسجّل يُرجع نفس رسالة كلمة المرور الخاطئة', async () => {
  const a = await call('anon', 'POST', '/api/auth/login', { body: { email: 'nobody' + uniq() + '@test.com', password: 'Password123' } });
  assert.strictEqual(a.status, 401);
  assert.match(a.data.error.message, /البريد الإلكتروني أو كلمة المرور/);
});

test('09 — /api/auth/me بدون جلسة يُرفض 401', async () => {
  const r = await call('anon', 'GET', '/api/auth/me');
  assert.strictEqual(r.status, 401);
});

test('10 — /api/auth/me مع الجلسة يعيد المستخدم والباقة', async () => {
  const r = await call('userA', 'GET', '/api/auth/me');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.user.email.endsWith('@test.com'));
  assert.strictEqual(r.data.plan.plan.key, 'free');
  assert.strictEqual(r.data.plan.usage.tenders, 0);
});

/* ==========================================================
   3) العطاءات
   ========================================================== */
let tenderA;

test('11 — إنشاء عطاء يعيد 201', async () => {
  const r = await call('userA', 'POST', '/api/tenders', {
    body: { name: 'عمارة سكنية — 6 طوابق', authority: 'أمانة عمان', closing: '2026-12-01', notes: 'نطاق كامل' }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.tender.status, 'new');
  assert.strictEqual(r.data.tender.name, 'عمارة سكنية — 6 طوابق');
  assert.strictEqual(r.data.tender.authority, 'أمانة عمان');
  tenderA = r.data.tender;
});

test('12 — إنشاء عطاء باسم فارغ يُرفض 422', async () => {
  const r = await call('userA', 'POST', '/api/tenders', { body: { name: '' } });
  assert.strictEqual(r.status, 422);
});

test('13 — إنشاء عطاء بتاريخ إغلاق بصيغة خاطئة يُرفض 422', async () => {
  const r = await call('userA', 'POST', '/api/tenders', { body: { name: 'عطاء', closing: '01/12/2026' } });
  assert.strictEqual(r.status, 422);
});

test('14 — قائمة العطاءات تعيد عطاءات المستخدم فقط', async () => {
  const r = await call('userA', 'GET', '/api/tenders');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 1);
  assert.strictEqual(r.data.tenders[0].id, tenderA.id);
});

test('15 — قراءة عطاء واحد تعيد ملفاته وطلباته', async () => {
  const r = await call('userA', 'GET', '/api/tenders/' + tenderA.id);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data.files));
  assert.ok(Array.isArray(r.data.requests));
});

test('16 — تحديث العطاء يعمل ويحدّث updated_at', async () => {
  const before = (await call('userA', 'GET', '/api/tenders/' + tenderA.id)).data.tender.updatedAt;
  const r = await call('userA', 'PATCH', '/api/tenders/' + tenderA.id, { body: { authority: 'بلدية جديدة', notes: 'محدّث' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.tender.authority, 'بلدية جديدة');
  assert.ok(r.data.tender.updatedAt >= before);
});

test('17 — حالة غير معروفة في التحديث تُرفض 422', async () => {
  const r = await call('userA', 'PATCH', '/api/tenders/' + tenderA.id, { body: { status: 'bogus' } });
  assert.strictEqual(r.status, 422);
});

/* ==========================================================
   4) الملفات
   ========================================================== */
let fileA;

test('18 — رفع ملف PDF يعمل ويعيد 201', async () => {
  const form = makeForm([{ name: 'arch-plan.pdf', content: 'PDF-FAKE-CONTENT-' + 'x'.repeat(200), type: 'application/pdf' }], { category: 'arch' });
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/files', { form });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.count, 1);
  assert.strictEqual(r.data.files[0].name, 'arch-plan.pdf');
  assert.strictEqual(r.data.files[0].category, 'arch');
  assert.ok(r.data.files[0].size > 0);
  fileA = r.data.files[0];
});

test('19 — رفع عدة ملفات بتصنيفات مختلفة في طلب واحد', async () => {
  const form = makeForm([
    { name: 'struct-slab.pdf', content: 'STRUCT', type: 'application/pdf' },
    { name: 'mep-hvac.pdf', content: 'MEP', type: 'application/pdf' },
    { name: 'boq.xlsx', content: 'BOQ', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  ], { categories: JSON.stringify(['struct', 'mep', 'boq']) });
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/files', { form });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.count, 3);
  const byName = Object.fromEntries(r.data.files.map((f) => [f.name, f.category]));
  assert.strictEqual(byName['struct-slab.pdf'], 'struct');
  assert.strictEqual(byName['mep-hvac.pdf'], 'mep');
  assert.strictEqual(byName['boq.xlsx'], 'boq');
});

test('20 — رفع ملف بامتداد خطر (.exe) يُرفض 415', async () => {
  const form = makeForm([{ name: 'malware.exe', content: 'MZ', type: 'application/octet-stream' }]);
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/files', { form });
  assert.strictEqual(r.status, 415);
  assert.strictEqual(r.data.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('21 — رفع ملف بسكربت (.sh) يُرفض 415', async () => {
  const form = makeForm([{ name: 'run.sh', content: '#!/bin/sh', type: 'text/x-sh' }]);
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/files', { form });
  assert.strictEqual(r.status, 415);
});

test('22 — قائمة ملفات العطاء تعيد 4 ملفات', async () => {
  const r = await call('userA', 'GET', '/api/tenders/' + tenderA.id + '/files');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 4);
});

test('23 — العطاء يصبح جاهزاً بعد الرفع', async () => {
  const r = await call('userA', 'GET', '/api/tenders/' + tenderA.id);
  assert.strictEqual(r.data.tender.status, 'ready');
  assert.strictEqual(r.data.tender.fileCount, 4);
});

test('24 — تحميل الملف المحمي يعيد المحتوى الأصلي', async () => {
  const res = await fetch(base + '/api/files/' + fileA.id + '/download', { headers: cookieFor('userA') });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.startsWith('PDF-FAKE-CONTENT-'), 'المحتوى يجب أن يطابق ما رُفع');
  assert.match(res.headers.get('content-disposition'), /attachment/);
});

test('25 — تحميل ملف بدون جلسة يُرفض 401', async () => {
  const res = await fetch(base + '/api/files/' + fileA.id + '/download');
  assert.strictEqual(res.status, 401);
});

test('26 — التصنيف غير المعروف يُحوَّل إلى other', async () => {
  const form = makeForm([{ name: 'weird.pdf', content: 'X', type: 'application/pdf' }], { category: 'nonsense' });
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/files', { form });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.files[0].category, 'other');
});

/* ==========================================================
   5) عزل المستخدمين — الأهم
   ========================================================== */
test('27 — مستخدم آخر لا يقدر يقرأ عطاء غيره (404)', async () => {
  await call('userC', 'POST', '/api/auth/register', { body: { name: 'مستخدم ج', email: 'c' + uniq() + '@test.com', password: 'Password123' } });
  const r = await call('userC', 'GET', '/api/tenders/' + tenderA.id);
  assert.strictEqual(r.status, 404, 'يجب إخفاء وجود العطاء بـ 404 لا 403');
  assert.strictEqual(r.data.error.code, 'NOT_FOUND');
});

test('28 — مستخدم آخر لا يقدر يعدّل عطاء غيره', async () => {
  const r = await call('userC', 'PATCH', '/api/tenders/' + tenderA.id, { body: { name: 'استوليت عليه' } });
  assert.strictEqual(r.status, 404);
  // تأكيد أن الاسم لم يتغير
  const check = await call('userA', 'GET', '/api/tenders/' + tenderA.id);
  assert.strictEqual(check.data.tender.name, 'عمارة سكنية — 6 طوابق');
});

test('29 — مستخدم آخر لا يقدر يحذف عطاء غيره', async () => {
  const r = await call('userC', 'DELETE', '/api/tenders/' + tenderA.id);
  assert.strictEqual(r.status, 404);
  const check = await call('userA', 'GET', '/api/tenders/' + tenderA.id);
  assert.strictEqual(check.status, 200, 'العطاء يجب أن يبقى');
});

test('30 — مستخدم آخر لا يقدر يرفع ملفاً على عطاء غيره', async () => {
  const form = makeForm([{ name: 'intrude.pdf', content: 'X', type: 'application/pdf' }]);
  const r = await call('userC', 'POST', '/api/tenders/' + tenderA.id + '/files', { form });
  assert.strictEqual(r.status, 404);
});

test('31 — مستخدم آخر لا يقدر يحمّل ملف غيره', async () => {
  const res = await fetch(base + '/api/files/' + fileA.id + '/download', { headers: cookieFor('userC') });
  assert.strictEqual(res.status, 404);
});

test('32 — مستخدم آخر لا يقدر يحذف ملف غيره', async () => {
  const r = await call('userC', 'DELETE', '/api/files/' + fileA.id);
  assert.strictEqual(r.status, 404);
  // تأكيد بقاء الملف
  const list = await call('userA', 'GET', '/api/tenders/' + tenderA.id + '/files');
  assert.ok(list.data.files.some((f) => f.id === fileA.id));
});

test('33 — قائمة عطاءات المستخدم ج لا تحتوي عطاءات المستخدم أ', async () => {
  const r = await call('userC', 'GET', '/api/tenders');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 0);
});

test('34 — طلب على عطاء غيره يُرفض', async () => {
  const r = await call('userC', 'POST', '/api/tenders/' + tenderA.id + '/requests', { body: { text: 'اختراق', kind: 'note' } });
  assert.strictEqual(r.status, 404);
});

/* ==========================================================
   6) الطلبات
   ========================================================== */
test('35 — إنشاء طلب على عطاء مملوك', async () => {
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/requests', { body: { text: 'أرجو تعديل جدول الدفعات', kind: 'change' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.request.kind, 'change');
  assert.strictEqual(r.data.request.status, 'open');
});

test('36 — طلب بنص قصير جداً يُرفض 422', async () => {
  const r = await call('userA', 'POST', '/api/tenders/' + tenderA.id + '/requests', { body: { text: 'ا', kind: 'note' } });
  assert.strictEqual(r.status, 422);
});

test('37 — قائمة الطلبات تعيد الطلب', async () => {
  const r = await call('userA', 'GET', '/api/tenders/' + tenderA.id + '/requests');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 1);
});

/* ==========================================================
   7) الباقة والاستهلاك
   ========================================================== */
test('38 — الاستهلاك يعكس العطاءات والملفات الفعلية', async () => {
  const r = await call('userA', 'GET', '/api/usage');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.usage.tenders, 1);
  assert.strictEqual(r.data.usage.tendersMax, 1);
  assert.strictEqual(r.data.usage.tendersPct, 100);
  assert.strictEqual(r.data.usage.files, 5);
  assert.ok(r.data.usage.bytes > 0);
});

test('39 — العطاء الثاني على الباقة المجانية يُرفض 402', async () => {
  const r = await call('userA', 'POST', '/api/tenders', { body: { name: 'عطاء ثانٍ' } });
  assert.strictEqual(r.status, 402, JSON.stringify(r.data));
  assert.strictEqual(r.data.error.code, 'PLAN_LIMIT');
  assert.strictEqual(r.data.error.details.limit, 1);
});

test('40 — الترقية إلى starter تسمح بعطاء ثانٍ', async () => {
  const up = await call('userA', 'POST', '/api/plan', { body: { planKey: 'starter' } });
  assert.strictEqual(up.status, 200, JSON.stringify(up.data));
  assert.strictEqual(up.data.plan.key, 'starter');

  const r = await call('userA', 'POST', '/api/tenders', { body: { name: 'عطاء ثانٍ' } });
  assert.strictEqual(r.status, 201);
});

test('41 — الرجوع لباقة أصغر من الاستهلاك يُرفض 409', async () => {
  const r = await call('userA', 'POST', '/api/plan', { body: { planKey: 'free' } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.error.code, 'CONFLICT');
});

test('42 — باقة غير معروفة تُرفض 422', async () => {
  const r = await call('userA', 'POST', '/api/plan', { body: { planKey: 'gold' } });
  assert.strictEqual(r.status, 422);
});

test('43 — قائمة الباقات تعيد الأربع', async () => {
  const r = await call('userA', 'GET', '/api/plans');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.plans.length, 4);
  assert.deepStrictEqual(r.data.plans.map((p) => p.key), ['free', 'starter', 'pro', 'ent']);
  assert.strictEqual(r.data.plans[3].maxTenders, null, 'Enterprise يجب أن تكون غير محدودة');
});

/* ==========================================================
   8) الحذف والخروج
   ========================================================== */
test('44 — حذف ملف يعمل ويحدّث العدد', async () => {
  const before = (await call('userA', 'GET', '/api/tenders/' + tenderA.id + '/files')).data.count;
  const r = await call('userA', 'DELETE', '/api/files/' + fileA.id);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.remaining, before - 1);
  const after = (await call('userA', 'GET', '/api/tenders/' + tenderA.id + '/files')).data.count;
  assert.strictEqual(after, before - 1);
});

test('45 — حذف نفس الملف مرة أخرى يعيد 404', async () => {
  const r = await call('userA', 'DELETE', '/api/files/' + fileA.id);
  assert.strictEqual(r.status, 404);
});

test('46 — الملف المحذوف لم يبق على القرص', async () => {
  const db = getDB();
  const row = db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileA.id);
  assert.strictEqual(row, undefined);
  const abs = path.join(process.env.UPLOAD_DIR, row ? row.rel_path : 'nonexistent');
  assert.strictEqual(fs.existsSync(abs), false);
});

test('47 — حذف العطاء يحذف ملفاته وطلباته', async () => {
  const r = await call('userA', 'DELETE', '/api/tenders/' + tenderA.id);
  assert.strictEqual(r.status, 200);
  const db = getDB();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM files WHERE tender_id = ?').get(tenderA.id).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM requests WHERE tender_id = ?').get(tenderA.id).n, 0);
  const get = await call('userA', 'GET', '/api/tenders/' + tenderA.id);
  assert.strictEqual(get.status, 404);
});

test('48 — تسجيل الخروج يبطل الجلسة', async () => {
  const out = await call('userA', 'POST', '/api/auth/logout');
  assert.strictEqual(out.status, 200);
  const me = await call('userA', 'GET', '/api/auth/me');
  assert.strictEqual(me.status, 401);
});

test('49 — نقطة API غير موجودة تعيد 404 بصيغة موحّدة', async () => {
  const r = await call('userA', 'GET', '/api/nope');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.error.code, 'NOT_FOUND');
});

test('50 — توكن مُلفَّق يُرفض 401', async () => {
  const res = await fetch(base + '/api/auth/me', { headers: { Cookie: 'tpkit_session=malformed.token.here' } });
  assert.strictEqual(res.status, 401);
});

/* ==========================================================
   9) انحدار: الواجهة ترسل null للحقول الاختيارية الفارغة
   (اكتُشف هذا الخلل بتشغيل الصفحة في متصفح حقيقي، وليس بـ curl)
   ========================================================== */
test('51 — إنشاء عطاء بحقول اختيارية = null (كما يرسلها المتصفح)', async () => {
  const email = 'nulltest' + uniq() + '@test.com';
  await call('nul', 'POST', '/api/auth/register', { body: { name: 'اختبار null', email, password: 'Password123', company: null } });
  const r = await call('nul', 'POST', '/api/tenders', {
    body: { name: 'عطاء بحقول فارغة', authority: null, closing: null, notes: null }
  });
  assert.strictEqual(r.status, 201, 'null في الحقول الاختيارية يجب أن يُقبل: ' + JSON.stringify(r.data));
  assert.strictEqual(r.data.tender.authority, null);
  assert.strictEqual(r.data.tender.closing, null);
  assert.strictEqual(r.data.tender.notes, null);
});

test('52 — تحديث عطاء بحقول اختيارية = null', async () => {
  // نستخدم العطاء الموجود (الباقة المجانية تسمح بعطاء واحد فقط)
  const list = await call('nul', 'GET', '/api/tenders');
  assert.strictEqual(list.status, 200);
  assert.ok(list.data.tenders.length >= 1, 'يجب أن يوجد العطاء من الاختبار السابق');
  const id = list.data.tenders[0].id;

  const u = await call('nul', 'PATCH', '/api/tenders/' + id, {
    body: { authority: null, closing: null, notes: null }
  });
  assert.strictEqual(u.status, 200, JSON.stringify(u.data));
  assert.strictEqual(u.data.tender.authority, null);
  assert.strictEqual(u.data.tender.closing, null);
  assert.strictEqual(u.data.tender.notes, null);
});

test('53 — تسجيل بحقل شركة = null', async () => {
  const r = await call('nul2', 'POST', '/api/auth/register', {
    body: { name: 'بلا شركة', email: 'noco' + uniq() + '@test.com', password: 'Password123', company: null }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.user.company, null);
});

test('54 — سلسلة كاملة كما تفعل الواجهة: إنشاء ثم رفع ثم حذف', async () => {
  const email = 'ui' + uniq() + '@test.com';
  await call('ui', 'POST', '/api/auth/register', { body: { name: 'محاكاة الواجهة', email, password: 'Password123', company: null } });

  const created = await call('ui', 'POST', '/api/tenders', {
    body: { name: 'عمارة سكنية — محاكاة', authority: null, closing: null, notes: null }
  });
  assert.strictEqual(created.status, 201, 'إنشاء: ' + JSON.stringify(created.data));
  const tid = created.data.tender.id;

  const up = await call('ui', 'POST', '/api/tenders/' + tid + '/files', {
    form: makeForm([{ name: 'arch-plan.pdf', content: 'X', type: 'application/pdf' }], { categories: JSON.stringify(['arch']) })
  });
  assert.strictEqual(up.status, 201, 'رفع: ' + JSON.stringify(up.data));
  const fid = up.data.files[0].id;

  const after = await call('ui', 'GET', '/api/tenders/' + tid);
  assert.strictEqual(after.data.tender.status, 'ready');
  assert.strictEqual(after.data.files.length, 1);

  const del = await call('ui', 'DELETE', '/api/files/' + fid);
  assert.strictEqual(del.status, 200);
  const back = await call('ui', 'GET', '/api/tenders/' + tid);
  assert.strictEqual(back.data.tender.status, 'new', 'بعد حذف كل الملفات يرجع العطاء إلى new');
});

/* ==========================================================
   باقات المشتريات: تجربة 14 يوماً ثم الدفع والتفعيل
   ========================================================== */
const reqs4 = () => [{ title: 'الخبرة', weight: 50, mandatory: true }, { title: 'المنهجية', weight: 50, mandatory: false }];
const mkTender = (who, n) => call(who, 'POST', '/api/procurement/tenders', { body: { name: 'عطاء ' + n, reference: 'R-' + uniq(), requirements: reqs4() } });

test('55 — باقات المشتريات الثلاث وأسعارها', async () => {
  const r = await call('anon', 'GET', '/api/billing/plans?audience=buyer');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.plans.map((p) => p.key), ['proc_basic', 'proc_pro', 'proc_ent']);
  assert.deepStrictEqual(r.data.plans.map((p) => p.priceMonth), [49, 149, 399]);
  assert.deepStrictEqual(r.data.plans.map((p) => p.maxUsers), [3, 10, null]);
  assert.strictEqual(r.data.plans[0].maxTenders, 10);
  assert.strictEqual(r.data.plans[1].maxTenders, null);
  assert.ok(r.data.plans.every((p) => p.trialDays === 14));
});

test('56 — مقاول لا يستطيع بدء تجربة أو فاتورة باقة مشتريات', async () => {
  await call('con', 'POST', '/api/auth/register', { body: { name: 'مقاول', email: 'c' + uniq() + '@t.com', password: 'Password123' } });
  assert.strictEqual((await call('con', 'POST', '/api/billing/trial', { body: { planKey: 'proc_basic' } })).status, 403);
  assert.strictEqual((await call('con', 'POST', '/api/billing/invoices', { body: { planKey: 'proc_pro' } })).status, 403);
});

test('57 — تجربة 14 يوماً تفتح الباقة مرة واحدة فقط', async () => {
  await call('buy', 'POST', '/api/auth/register', { body: { name: 'مشتريات', email: 'b' + uniq() + '@t.com', password: 'Password123', role: 'buyer' } });
  const t = await call('buy', 'POST', '/api/billing/trial', { body: { planKey: 'proc_pro' } });
  assert.strictEqual(t.status, 201, JSON.stringify(t.data));
  const me = await call('buy', 'GET', '/api/auth/me');
  assert.strictEqual(me.data.plan.plan.key, 'proc_pro');
  const days = Math.round((me.data.plan.subscription.endsAt - Date.now() / 1000) / 86400);
  assert.strictEqual(days, 14);
  assert.strictEqual(me.data.plan.subscription.source, 'trial');
  assert.strictEqual((await call('buy', 'POST', '/api/billing/trial', { body: { planKey: 'proc_basic' } })).status, 409);
});

test('58 — الباقة المجانية تحدّ المشتريات بعطاء واحد، وBasic بعشرة', async () => {
  await call('free', 'POST', '/api/auth/register', { body: { name: 'مجاني', email: 'f' + uniq() + '@t.com', password: 'Password123', role: 'buyer' } });
  assert.strictEqual((await mkTender('free', 1)).status, 201);
  assert.strictEqual((await mkTender('free', 2)).status, 403, 'العطاء الثاني يتجاوز الحد');
  await call('free', 'POST', '/api/billing/trial', { body: { planKey: 'proc_basic' } });
  // عطاء واحد منشور سابقاً + 9 جديدة = 10 (حد Basic)
  for (let i = 0; i < 9; i++) assert.strictEqual((await mkTender('free', 10 + i)).status, 201);
  assert.strictEqual((await mkTender('free', 99)).status, 403);
});

test('59 — انتهاء التجربة يعيد المستخدم للمجانية فوراً', async () => {
  const email = 'x' + uniq() + '@t.com';
  await call('exp', 'POST', '/api/auth/register', { body: { name: 'منتهي', email, password: 'Password123', role: 'buyer' } });
  await call('exp', 'POST', '/api/billing/trial', { body: { planKey: 'proc_ent' } });
  getDB().prepare("UPDATE subscriptions SET ends_at = unixepoch() - 10 WHERE source='trial' AND plan_key='proc_ent' AND user_id=(SELECT id FROM users WHERE email=?)").run(email);
  const me = await call('exp', 'GET', '/api/auth/me');
  assert.strictEqual(me.data.plan.plan.key, 'free');
});

test('60 — الدفع: فاتورة + إيصال + سعر خاص + اعتماد المدير يفتح الباقة', async () => {
  const email = 'p' + uniq() + '@t.com';
  await call('pay', 'POST', '/api/auth/register', { body: { name: 'دافع', email, password: 'Password123', role: 'buyer' } });
  const inv = await call('pay', 'POST', '/api/billing/invoices', { body: { planKey: 'proc_ent', billingCycle: 'monthly', currency: 'USD' } });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.data));
  assert.strictEqual(inv.data.invoice.amount, 399);
  const id = inv.data.invoice.id;
  // لا اعتماد قبل رفع الإيصال، والباقة ما زالت مغلقة
  const adminEmail = 'a' + uniq() + '@t.com';
  await call('adm', 'POST', '/api/auth/register', { body: { name: 'مدير', email: adminEmail, password: 'Password123' } });
  getDB().prepare("UPDATE users SET role='admin' WHERE email=?").run(adminEmail);
  await call('adm', 'POST', '/api/auth/login', { body: { email: adminEmail, password: 'Password123' } });
  assert.strictEqual((await call('adm', 'POST', '/api/billing/admin/invoices/' + id + '/approve', { body: {} })).status, 409);
  assert.strictEqual((await call('pay', 'GET', '/api/auth/me')).data.plan.plan.key, 'free');
  // غير المدير لا يعدّل السعر
  assert.strictEqual((await call('pay', 'POST', '/api/billing/admin/invoices/' + id + '/amount', { body: { amount: 1 } })).status, 403);
  // سعر خاص ثم إيصال ثم اعتماد
  assert.strictEqual((await call('adm', 'POST', '/api/billing/admin/invoices/' + id + '/amount', { body: { amount: 520 } })).status, 200);
  const fd = new FormData();
  fd.append('receipt', new Blob(['%PDF-1.4 receipt'], { type: 'application/pdf' }), 'receipt.pdf');
  assert.strictEqual((await call('pay', 'POST', '/api/billing/invoices/' + id + '/receipt', { form: fd })).status, 201);
  const ok = await call('adm', 'POST', '/api/billing/admin/invoices/' + id + '/approve', { body: {} });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  const me = await call('pay', 'GET', '/api/auth/me');
  assert.strictEqual(me.data.plan.plan.key, 'proc_ent');
  assert.strictEqual(me.data.plan.subscription.source, 'manual');
  const days = Math.round((me.data.plan.subscription.endsAt - Date.now() / 1000) / 86400);
  assert.strictEqual(days, 30);
  assert.strictEqual((await mkTender('pay', 1)).status, 201);
  // لا تعديل للسعر بعد الدفع
  assert.strictEqual((await call('adm', 'POST', '/api/billing/admin/invoices/' + id + '/amount', { body: { amount: 5 } })).status, 409);
});

test('61 — بيانات الدفع تُقرأ من الإعدادات وتُعرض عبر /api/payment-info', async () => {
  const r = await call('anon2', 'GET', '/api/payment-info');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.payment.swift, 'UBSIJOAXXXX');
  assert.strictEqual(r.data.payment.iban, 'JO07UBSI1220000330111332981002');
  assert.strictEqual(r.data.ibanValid, true);
  assert.ok(r.data.payment.accountHolder.length > 5);
});

test('62 — ملفات Excel/PDF تُخدم من /documents، وبقية ملفات المجلد مغلقة', async () => {
  const b = base;
  const ok = await fetch(b + '/documents/technical-proposal-kit_v5/quantity-takeoff-en.xlsx');
  assert.strictEqual(ok.status, 200);
  assert.ok((await ok.arrayBuffer()).byteLength > 1000);
  assert.strictEqual((await fetch(b + '/documents/technical-proposal-kit/quantity-takeoff.xlsx')).status, 200);
  assert.strictEqual((await fetch(b + '/documents/technical-proposal-kit_v5/technical-proposal-kit-en.pdf')).status, 200);
  for (const hidden of ['/documents/billing-implementation-ar.md', '/documents/technical-proposal-kit_v5/env.example', '/documents/technical-proposal-kit_v5/test-results.txt', '/documents/technical-proposal-kit_v2/quantity-takeoff-en.xlsx']) {
    assert.notStrictEqual((await fetch(b + hidden)).status, 200, hidden);
  }
});


test('63 — دليل APC العام يعمل داخل MMC دون تسجيل دخول ويعرض بيانات العطاء', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, ...args) => {
    const u = String(url);
    if (!u.includes('arabpotash.com')) return originalFetch(url, ...args);
    const html = u.includes('/Modules/Tenders')
      ? '<html><a href="/En/TendersDetails?PID=98765">Tender details</a><a href="/En/TendersDetails?PID=98766">Incomplete tender</a></html>'
      : u.includes('PID=98766')
        ? '<html><body><h1>Tender title and number: Incomplete civil works</h1><div>Purchase Date: 01/11/2026</div><div>Copy Price: 50 JOD</div></body></html>'
        : '<html><body><h1>Tender title and number: Civil works package APC-2026-01</h1><div>Purchase Date: 01/11/2026</div><div>Closing date: 20/11/2026</div><div>Copy Price: 50 JOD</div><div>Bid Bond Value: 5,000 JOD</div><div>Vendor Qualifications: Grade 1 contractor</div><div>Remarks: Submit technical offer</div><a href="/files/apc-announcement.pdf">Announcement PDF</a></body></html>';
    return { ok: true, status: 200, text: async () => html };
  };
  try {
    const r = await call('apc-anon', 'GET', '/api/public-tenders/apc');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.source, 'Arab Potash Company (APC)');
    assert.strictEqual(r.data.count, 2, 'both source records, including incomplete ones, are retained');
    const tender = r.data.tenders[0];
    assert.strictEqual(tender.id, 'apc-98765');
    assert.match(tender.title, /APC-2026-01/);
    assert.match(tender.closingDate, /20\/11\/2026/);
    const apcStored = getDB().prepare("SELECT closing_at,status FROM public_tenders WHERE id='apc-98765'").get();
    assert.strictEqual(apcStored.closing_at, '2026-11-20', 'APC dates must be stored in sortable ISO format');
    assert.strictEqual(apcStored.status, 'open', 'future APC closing dates must remain open');
    assert.match(tender.bidBond, /5,000 JOD/);
    assert.strictEqual(tender.documents.length, 1);
    assert.match(tender.documents[0].url, /apc-announcement\.pdf$/);
    const indexed = await call('apc-index', 'GET', '/api/public-tenders?q=APC-2026-01');
    assert.strictEqual(indexed.status, 200, JSON.stringify(indexed.data));
    assert.strictEqual(indexed.data.total, 1, 'only the verified APC tender should be searchable publicly');
    const incomplete = getDB().prepare("SELECT review_status FROM public_tenders WHERE id='apc-98766'").get();
    assert.strictEqual(incomplete.review_status, 'needs-review');
    assert.strictEqual(indexed.data.tenders[0].sourceKey, 'arab-potash-company');
    const details = await call('apc-details', 'GET', '/api/public-tenders/apc-98765');
    assert.strictEqual(details.status, 200, JSON.stringify(details.data));
    assert.strictEqual(details.data.documents.length, 1);
    const sourceList = await call('sources', 'GET', '/api/public-tenders/sources');
    assert.strictEqual(sourceList.status, 200);
    assert.ok(sourceList.data.sources.some(s => s.sourceKey === 'joneps-jordan'));
    assert.ok(sourceList.data.sources.some(s => s.sourceKey === 'ungm'));
    // Source registry coverage: listing a source must not imply its connector is active.
    for (const key of ['nepco-jordan','jopetrol-jordan','adc-jordan','aramco-saudi','maaden-saudi','dubai-procurement-uae','abudhabi-procurement-uae']) {
      const source = sourceList.data.sources.find(s => s.sourceKey === key);
      assert.ok(source, 'expected registered source: ' + key);
      assert.strictEqual(source.connectorStatus, 'planned', key + ' must not be presented as automatically synchronized');
    }
  } finally {
    global.fetch = originalFetch;
  }
});


test('64 — موصل البنك الدولي يحول الإشعارات العامة إلى فهرس MMC', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    assert.match(String(url), /search\.worldbank\.org\/api\/v2\/procnotices/);
    return {
      ok: true, status: 200,
      json: async () => ({ rows: 2, os: 0, page: 1, total: 2, procnotices: [
        { id: 'WB-TEST-2026-001', bid_description: 'Road rehabilitation and drainage works', project_ctry_name: 'Jordan', notice_type: 'Request for Bids', submission_deadline_date: '2026-12-15', noticedate: '2026-10-20', project_name: 'Municipal infrastructure project' },
        { id: 'WB-TEST-2026-002', bid_description: 'Incomplete procurement notice', project_ctry_name: 'Unknown country', notice_type: 'Request for Information', noticedate: '2026-10-21' }
      ] })
    };
  };
  try {
    const response = await call('wb-anon', 'GET', '/api/public-tenders/world-bank?refresh=1');
    assert.strictEqual(response.status, 200, JSON.stringify(response.data));
    assert.strictEqual(response.data.count, 2, 'source response retains incomplete notices for review');
    assert.strictEqual(response.data.tenders[0].countryCode, 'JO');
    assert.strictEqual(response.data.tenders[0].closingAt, '2026-12-15');
    const indexed = await call('wb-index', 'GET', '/api/public-tenders?source=world-bank-procurement&q=Road%20rehabilitation');
    assert.strictEqual(indexed.status, 200);
    assert.strictEqual(indexed.data.total, 1, 'only complete notices for target countries are published');
    const held = getDB().prepare("SELECT review_status FROM public_tenders WHERE id='wb-WB-TEST-2026-002'").get();
    assert.strictEqual(held.review_status, 'needs-review');
    const source = getDB().prepare("SELECT connector_status,last_sync_status FROM tender_sources WHERE source_key='world-bank-procurement'").get();
    assert.strictEqual(source.connector_status, 'active');
    assert.strictEqual(source.last_sync_status, 'success');
  } finally {
    global.fetch = originalFetch;
  }
});
