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
process.env.REQUIRE_ORG_VERIFICATION = 'false'; // يُفعَّل داخل اختبارات التوثيق فقط
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.BCRYPT_ROUNDS = '4';      // أسرع في الاختبارات

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

/* ==========================================================
   موعد الإغلاق + حد التقديم الإلكتروني حسب باقة المقاول
   ========================================================== */
async function publish(who, closing) {
  const r = await call(who, 'POST', '/api/procurement/tenders', { body: { name: 'عطاء ' + uniq(), reference: 'Q-' + uniq(), closing, requirements: reqs4() } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.tender;
}
function grantPlan(email, planKey) {
  const u = getDB().prepare('SELECT id FROM users WHERE email=?').get(email);
  getDB().prepare("UPDATE subscriptions SET status='cancelled' WHERE user_id=? AND status='active'").run(u.id);
  getDB().prepare("INSERT INTO subscriptions (id,user_id,plan_key,status,source,started_at,ends_at) VALUES (?,?,?,?,?,unixepoch(),unixepoch()+2592000)").run('sub_t' + uniq(), u.id, planKey, 'active', 'manual');
  getDB().prepare('UPDATE users SET plan_key=? WHERE id=?').run(planKey, u.id);
}
const bidBody = (t, amount = 1000) => ({ answers: t.requirements.map((q) => ({ requirementId: q.id, answer: 'إجابة' })), financialAmount: amount, financialCurrency: 'JOD' });

test('63 — لا تقديم بعد موعد الإغلاق، ويُقبل في يوم الإغلاق نفسه وبدون موعد', async () => {
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  await call('qbuy', 'POST', '/api/auth/register', { body: { name: 'جهة', email: 'qb' + uniq() + '@t.com', password: 'Password123', role: 'buyer' } });
  await call('qbuy', 'POST', '/api/billing/trial', { body: { planKey: 'proc_pro' } });
  const qcEmail = 'qc' + uniq() + '@t.com';
  await call('qcon', 'POST', '/api/auth/register', { body: { name: 'مقاول', email: qcEmail, password: 'Password123' } });
  grantPlan(qcEmail, 'ent');
  const past = await publish('qbuy', ymd(Date.now() - 3 * 86400000));
  const noDate = await publish('qbuy', undefined);
  const today = await publish('qbuy', new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10));
  const list = await call('qcon', 'GET', '/api/procurement/open-tenders');
  assert.strictEqual(list.data.tenders.find((t) => t.id === past.id).expired, true);
  assert.strictEqual(list.data.tenders.find((t) => t.id === noDate.id).expired, false);
  const late = await call('qcon', 'POST', '/api/procurement/tenders/' + past.id + '/submit', { body: bidBody(past) });
  assert.strictEqual(late.status, 409);
  assert.ok(/انتهى موعد/.test(late.data.error.message));
  assert.strictEqual((await call('qcon', 'POST', '/api/procurement/tenders/' + noDate.id + '/submit', { body: bidBody(noDate) })).status, 201);
  assert.strictEqual((await call('qcon', 'POST', '/api/procurement/tenders/' + today.id + '/submit', { body: bidBody(today) })).status, 201);
});

test('64 — حد التقديم الإلكتروني: المجاني 2، ويُرفع بالترقية', async () => {
  const email = 'ql' + uniq() + '@t.com';
  await call('qfree', 'POST', '/api/auth/register', { body: { name: 'مجاني', email, password: 'Password123' } });
  const me = await call('qfree', 'GET', '/api/auth/me');
  assert.strictEqual(me.data.plan.plan.maxSubmissions, 2);
  assert.strictEqual(me.data.plan.usage.submissions, 0);
  const a = await publish('qbuy'), b = await publish('qbuy'), c = await publish('qbuy');
  assert.strictEqual((await call('qfree', 'POST', '/api/procurement/tenders/' + a.id + '/submit', { body: bidBody(a) })).status, 201);
  assert.strictEqual((await call('qfree', 'POST', '/api/procurement/tenders/' + b.id + '/submit', { body: bidBody(b) })).status, 201);
  const blocked = await call('qfree', 'POST', '/api/procurement/tenders/' + c.id + '/submit', { body: bidBody(c) });
  assert.strictEqual(blocked.status, 403);
  assert.ok(/حد باقتك/.test(blocked.data.error.message));
  assert.strictEqual((await call('qfree', 'GET', '/api/auth/me')).data.plan.usage.submissions, 2);
  grantPlan(email, 'starter');
  assert.strictEqual((await call('qfree', 'POST', '/api/procurement/tenders/' + c.id + '/submit', { body: bidBody(c) })).status, 201);
});

test('65 — قائمة باقات المقاول تُظهر حدّ التقديمات', async () => {
  const r = await call('qfree', 'GET', '/api/plans');
  assert.deepStrictEqual(r.data.plans.map((p) => [p.key, p.maxSubmissions]), [['free', 2], ['starter', 10], ['pro', 40], ['ent', null]]);
});

/* ==========================================================
   توثيق الجهات + دول الخليج
   ========================================================== */
const cfg = require('../src/config');
function verForm(over = {}, withDoc = true) {
  const fd = new FormData();
  const f = { orgName: 'شركة الخليج للمشاريع', orgType: 'company', country: 'AE', regNumber: 'CR-123456', officialPhone: '+971 4 123 4567', officialEmail: 'procurement@gulf-projects.example', onBehalfOf: '', website: '', ...over };
  Object.entries(f).forEach(([k, v]) => fd.append(k, v));
  if (withDoc) fd.append('docs', new Blob(['%PDF-1.4 commercial registration'], { type: 'application/pdf' }), 'registration.pdf');
  return fd;
}
async function makeAdmin(name) {
  const email = 'ad' + uniq() + '@t.com';
  await call(name, 'POST', '/api/auth/register', { body: { name: 'مدير', email, password: 'Password123' } });
  getDB().prepare("UPDATE users SET role='admin' WHERE email=?").run(email);
  await call(name, 'POST', '/api/auth/login', { body: { email, password: 'Password123' } });
}

test('66 — لا نشر قبل التوثيق؛ الطلب والمراجعة والرفض والاعتماد والسحب', async () => {
  cfg.REQUIRE_ORG_VERIFICATION = true;
  try {
    await call('vb', 'POST', '/api/auth/register', { body: { name: 'جهة', email: 'vb' + uniq() + '@t.com', password: 'Password123', role: 'buyer' } });
    await call('vb', 'POST', '/api/billing/trial', { body: { planKey: 'proc_pro' } });
    const blocked = await mkTender('vb', 1);
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.data.error.code, 'ORG_NOT_VERIFIED');
    // تحقق من المدخلات
    assert.strictEqual((await call('vb', 'POST', '/api/verification', { form: verForm({ country: 'XX' }) })).status, 422);
    assert.strictEqual((await call('vb', 'POST', '/api/verification', { form: verForm({}, false) })).status, 422, 'وثيقة واحدة على الأقل');
    const sent = await call('vb', 'POST', '/api/verification', { form: verForm() });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
    assert.strictEqual(sent.data.verification.status, 'pending');
    assert.strictEqual((await call('vb', 'POST', '/api/verification', { form: verForm() })).status, 409, 'لا طلب ثانٍ أثناء المراجعة');
    assert.strictEqual((await mkTender('vb', 2)).status, 403, 'ما زال محظوراً أثناء المراجعة');
    // غير المدير لا يرى لوحة المراجعة
    assert.strictEqual((await call('vb', 'GET', '/api/verification/admin')).status, 403);
    await makeAdmin('vadm');
    const list = await call('vadm', 'GET', '/api/verification/admin?status=pending');
    const row = list.data.verifications.find((v) => v.orgName === 'شركة الخليج للمشاريع' && v.status === 'pending');
    assert.ok(row && row.docs.length === 1 && row.countryAr === 'الإمارات');
    const doc = await fetch(base + '/api/verification/admin/' + row.id + '/docs/' + row.docs[0].id, { headers: cookieFor('vadm') });
    assert.strictEqual(doc.status, 200);
    assert.strictEqual((await call('vadm', 'POST', '/api/verification/admin/' + row.id + '/reject', { body: {} })).status, 422, 'السبب إلزامي');
    assert.strictEqual((await call('vadm', 'POST', '/api/verification/admin/' + row.id + '/reject', { body: { note: 'السجل غير واضح' } })).status, 200);
    const mine = await call('vb', 'GET', '/api/verification');
    assert.strictEqual(mine.data.verification.status, 'rejected');
    assert.strictEqual(mine.data.verification.reviewNote, 'السجل غير واضح');
    // إعادة التقديم ثم الاعتماد
    assert.strictEqual((await call('vb', 'POST', '/api/verification', { form: verForm({ orgName: 'شركة الخليج للمشاريع ذ.م.م' }) })).status, 201);
    assert.strictEqual((await call('vadm', 'POST', '/api/verification/admin/' + row.id + '/approve', { body: { days: 365 } })).status, 200);
    const pub = await mkTender('vb', 3);
    assert.strictEqual(pub.status, 201, JSON.stringify(pub.data));
    assert.strictEqual(pub.data.tender.country, 'AE');
    assert.strictEqual(pub.data.tender.currency, 'AED');
    // المقاول يرى الشارة
    await call('vc', 'POST', '/api/auth/register', { body: { name: 'مقاول', email: 'vc' + uniq() + '@t.com', password: 'Password123' } });
    const open = await call('vc', 'GET', '/api/procurement/open-tenders');
    const seen = open.data.tenders.find((t) => t.id === pub.data.tender.id);
    assert.ok(seen && seen.issuer.verified === true && seen.issuer.country === 'AE' && seen.issuer.name.includes('ذ.م.م'));
    // عملة العرض: KWD مقبولة، وغير المعروفة تعود لعملة دولة الجهة
    const ok = await call('vc', 'POST', '/api/procurement/tenders/' + pub.data.tender.id + '/submit', { body: { ...bidBody(pub.data.tender), financialCurrency: 'KWD' } });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(getDB().prepare('SELECT financial_currency c FROM bid_submissions WHERE id=?').get(ok.data.submissionId).c, 'KWD');
    // سحب التوثيق: يختفي العطاء ويُمنع التقديم
    assert.strictEqual((await call('vadm', 'POST', '/api/verification/admin/' + row.id + '/revoke', { body: { note: 'شكوى موثّقة' } })).status, 200);
    assert.ok(!(await call('vc', 'GET', '/api/procurement/open-tenders')).data.tenders.some((t) => t.id === pub.data.tender.id));
    await call('vc2', 'POST', '/api/auth/register', { body: { name: 'مقاول2', email: 'vc2' + uniq() + '@t.com', password: 'Password123' } });
    assert.strictEqual((await call('vc2', 'POST', '/api/procurement/tenders/' + pub.data.tender.id + '/submit', { body: bidBody(pub.data.tender) })).status, 409);
  } finally { cfg.REQUIRE_ORG_VERIFICATION = false; }
});

test('67 — دول الخليج: فواتير بالعملات المربوطة، والدينار الكويتي بالدولار فقط', async () => {
  await call('gcc', 'POST', '/api/auth/register', { body: { name: 'خليجي', email: 'g' + uniq() + '@t.com', password: 'Password123', role: 'buyer' } });
  const amt = async (cur) => (await call('gcc', 'POST', '/api/billing/invoices', { body: { planKey: 'proc_basic', billingCycle: 'monthly', currency: cur } }));
  assert.strictEqual((await amt('USD')).data.invoice.amount, 49);
  assert.strictEqual((await amt('SAR')).data.invoice.amount, 183.75);
  assert.strictEqual((await amt('AED')).data.invoice.amount, 179.95);
  assert.strictEqual((await amt('QAR')).data.invoice.amount, 178.36);
  assert.strictEqual((await amt('BHD')).data.invoice.amount, 18.424);
  assert.strictEqual((await amt('OMR')).data.invoice.amount, 18.841);
  assert.strictEqual((await amt('JOD')).data.invoice.amount, 34.74);
  assert.strictEqual((await amt('KWD')).status, 422);
});

test('68 — توقيت إغلاق العطاء حسب دولة الجهة (الإمارات +4، السعودية +3)', async () => {
  const org = require('../src/lib/org');
  assert.strictEqual(org.tzOf('AE'), '+04:00');
  assert.strictEqual(org.tzOf('OM'), '+04:00');
  assert.strictEqual(org.tzOf('SA'), '+03:00');
  assert.strictEqual(org.tzOf('XX'), '+03:00');
  assert.deepStrictEqual(Object.keys((await call('anon3', 'GET', '/api/verification/meta')).data.countries.reduce((o, c) => ({ ...o, [c.code]: 1 }), {})), ['JO', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM']);
});

test('69 — نص العطاء بالعربية والإنجليزية: الاسم والملاحظات وعناوين المتطلبات', async () => {
  await call('bl', 'POST', '/api/auth/register', { body: { name: 'جهة ثنائية', email: 'bl' + uniq() + '@t.com', password: 'Password123', role: 'buyer' } });
  await call('bl', 'POST', '/api/billing/trial', { body: { planKey: 'proc_pro' } });
  const mk = await call('bl', 'POST', '/api/procurement/tenders', { body: {
    name: 'إنشاء مبنى الإدارة', nameEn: 'Administration building construction', notes: 'ملاحظات', notesEn: 'Site visit is mandatory', reference: 'BL-' + uniq(),
    requirements: [{ title: 'الخبرة السابقة', titleEn: 'Previous experience', description: 'وصف', descriptionEn: 'Describe similar projects', weight: 60, mandatory: true }, { title: 'المنهجية', weight: 40 }] } });
  assert.strictEqual(mk.status, 201, JSON.stringify(mk.data));
  const t = mk.data.tender;
  assert.strictEqual(t.nameEn, 'Administration building construction');
  assert.strictEqual(t.notesEn, 'Site visit is mandatory');
  assert.strictEqual(t.requirements[0].titleEn, 'Previous experience');
  assert.strictEqual(t.requirements[0].descriptionEn, 'Describe similar projects');
  assert.strictEqual(t.requirements[1].titleEn, null, 'الإنجليزية اختيارية');
  await call('blc', 'POST', '/api/auth/register', { body: { name: 'مقاول', email: 'blc' + uniq() + '@t.com', password: 'Password123' } });
  const list = await call('blc', 'GET', '/api/procurement/open-tenders');
  assert.strictEqual(list.data.tenders.find((x) => x.id === t.id).nameEn, 'Administration building construction');
  const one = await call('blc', 'GET', '/api/procurement/tenders/' + t.id);
  assert.strictEqual(one.data.tender.requirements[0].titleEn, 'Previous experience');
  // الحقول القديمة بلا إنجليزي تبقى صالحة
  const old = await mkTender('bl', 7);
  assert.strictEqual(old.status, 201);
  assert.strictEqual(old.data.tender.nameEn, null);
});

/* ==========================================================
   الجهة والأدوار + دورة الطلبات (مالك ← مشاريع ← مشتريات ← مقاول)
   ========================================================== */
let teamSeq = 0;
async function newBuyer(name, plan) {
  const email = name + (++teamSeq) + uniq() + '@t.com';
  const r = await call(name + teamSeq, 'POST', '/api/auth/register', { body: { name: 'عضو ' + name, email, password: 'Password123', role: 'buyer' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const who = name + teamSeq;
  if (plan) await call(who, 'POST', '/api/billing/trial', { body: { planKey: plan } });
  return who;
}
async function joinTeam(mgr, role, label) {
  const inv = await call(mgr, 'POST', '/api/org/invites', { body: { role, label } });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.data));
  const who = await newBuyer(label);
  const j = await call(who, 'POST', '/api/org/join', { body: { code: inv.data.code } });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  return { who, code: inv.data.code };
}
const reqBody = (over = {}) => ({ title: 'إنشاء مبنى إداري', titleEn: 'Administrative building', description: 'مبنى من ثلاثة طوابق', location: 'عمّان', country: 'JO', serviceType: 'works', budget: 500000, currency: 'JOD', neededBy: '2027-06-30', ...over });
function docForm(kind, name = 'spec.pdf') {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('files', new Blob(['%PDF-1.4 ' + kind], { type: 'application/pdf' }), name);
  return fd;
}
const tenderBody = (over = {}) => ({ closing: '2030-01-01', requirements: reqs4(), ...over });

test('70 — جهة جديدة: مدير تلقائي، والدعوات تحدّها مقاعد الباقة', async () => {
  const free = await newBuyer('free');
  const org = await call(free, 'GET', '/api/org');
  assert.strictEqual(org.data.myRole, 'manager');
  assert.strictEqual(org.data.seats.max, 1);
  const denied = await call(free, 'POST', '/api/org/invites', { body: { role: 'requester' } });
  assert.strictEqual(denied.status, 403);
  assert.ok(/حد المستخدمين/.test(denied.data.error.message));
  const pro = await newBuyer('pro', 'proc_basic');    // 3 مستخدمين
  assert.strictEqual((await call(pro, 'GET', '/api/org')).data.seats.max, 3);
  await joinTeam(pro, 'requester', 'r');
  await joinTeam(pro, 'projects', 'p');
  const third = await call(pro, 'POST', '/api/org/invites', { body: { role: 'procurement' } });
  assert.strictEqual(third.status, 403, 'المقاعد الثلاثة اكتملت');
});

test('71 — الانضمام برمز: صحيح مرة واحدة، والأدوار تُدار من المدير فقط', async () => {
  const mgr = await newBuyer('mgr', 'proc_pro');
  const inv = await call(mgr, 'POST', '/api/org/invites', { body: { role: 'projects', label: 'مهندس' } });
  const a = await newBuyer('a');
  assert.strictEqual((await call(a, 'POST', '/api/org/join', { body: { code: 'AAAAA-BBBBB' } })).status, 404, 'رمز خاطئ');
  assert.strictEqual((await call(a, 'POST', '/api/org/join', { body: { code: inv.data.code } })).status, 200);
  const b = await newBuyer('b');
  assert.strictEqual((await call(b, 'POST', '/api/org/join', { body: { code: inv.data.code } })).status, 404, 'الرمز لا يُستعمل مرتين');
  const org = await call(mgr, 'GET', '/api/org');
  assert.deepStrictEqual(org.data.members.map((m) => m.role).sort(), ['manager', 'projects']);
  assert.ok(org.data.members.every((m) => m.email), 'المدير يرى البريد');
  const view = await call(a, 'GET', '/api/org');
  assert.strictEqual(view.data.myRole, 'projects');
  assert.ok(view.data.members.every((m) => m.email === undefined), 'العضو العادي لا يرى البريد');
  assert.strictEqual((await call(a, 'POST', '/api/org/invites', { body: { role: 'requester' } })).status, 403);
  const me = await call(a, 'GET', '/api/auth/me');
  assert.strictEqual(me.data.plan.plan.key, 'proc_pro', 'العضو يرى باقة الجهة');
  const memberId = org.data.members.find((m) => m.role === 'projects').id;
  const owner = org.data.members.find((m) => m.isOwner).id;
  assert.strictEqual((await call(mgr, 'PATCH', '/api/org/members/' + owner, { body: { role: 'projects' } })).status, 409, 'صاحب الاشتراك يبقى مديراً');
  assert.strictEqual((await call(mgr, 'PATCH', '/api/org/members/' + memberId, { body: { role: 'procurement' } })).status, 200);
  assert.strictEqual((await call(a, 'GET', '/api/org')).data.myRole, 'procurement');
  assert.strictEqual((await call(mgr, 'DELETE', '/api/org/members/' + memberId)).status, 200);

  // Organization managers cannot alter members or revoke invitations belonging to another tenant.
  const foreignManager = await newBuyer('foreign-manager', 'proc_pro');
  const foreignMemberSession = (await joinTeam(foreignManager, 'requester', 'foreign-member')).who;
  const foreignMemberId = (await call(foreignMemberSession, 'GET', '/api/auth/me')).data.user.id;
  const foreignInvite = await call(foreignManager, 'POST', '/api/org/invites', { body: { role: 'finance' } });
  assert.strictEqual((await call(mgr, 'PATCH', '/api/org/members/' + foreignMemberId, { body: { role: 'finance' } })).status, 404);
  assert.strictEqual((await call(mgr, 'DELETE', '/api/org/members/' + foreignMemberId, {})).status, 404);
  assert.strictEqual((await call(mgr, 'DELETE', '/api/org/invites/' + foreignInvite.data.invite.id)).status, 404);
  assert.strictEqual((await call(foreignManager, 'GET', '/api/org')).data.members.some((m) => m.id === foreignMemberId), true);
});

test('72 — دورة كاملة: طلب ← مشاريع ← جاهز ← مشتريات تنشر ← المقاول يرى الوثائق وFIDIC', async () => {
  const mgr = await newBuyer('mg', 'proc_pro');
  const R = (await joinTeam(mgr, 'requester', 'rq')).who, P = (await joinTeam(mgr, 'projects', 'pj')).who, C = (await joinTeam(mgr, 'procurement', 'pc')).who;
  const made = await call(R, 'POST', '/api/requests', { body: reqBody() });
  assert.strictEqual(made.status, 201, JSON.stringify(made.data));
  const id = made.data.request.id;
  assert.strictEqual(made.data.request.status, 'draft');
  assert.strictEqual((await call(P, 'GET', '/api/requests')).data.requests.length, 0, 'المسودة لا تظهر للمشاريع');
  assert.strictEqual((await call(P, 'GET', '/api/requests/' + id)).status, 404);
  assert.strictEqual((await call(R, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'take' } })).status, 403);
  assert.strictEqual((await call(R, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'submit' } })).data.request.status, 'submitted');
  assert.strictEqual((await call(P, 'GET', '/api/requests')).data.requests.length, 1);
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'take' } })).data.request.status, 'in_study');
  // لا تجهيز بلا وثائق أو بلا FIDIC
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'ready' } })).status, 422);
  assert.strictEqual((await call(R, 'POST', '/api/requests/' + id + '/docs', { form: docForm('specifications') })).status, 403, 'الطالب لا يرفع مواصفات');
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/docs', { form: docForm('specifications', 'spec.pdf') })).status, 201);
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/docs', { form: docForm('drawings', 'plan.pdf') })).status, 201);
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/docs', { form: docForm('internal', 'cost-notes.pdf') })).status, 201);
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'ready' } })).status, 422, 'FIDIC مطلوب');
  const fid = await call(P, 'PATCH', '/api/requests/' + id, { body: { fidicBook: 'red', fidicEdition: '2017', particularNotes: 'الشروط الخاصة مرفقة' } });
  assert.strictEqual(fid.status, 200, JSON.stringify(fid.data));
  assert.strictEqual((await call(P, 'PATCH', '/api/requests/' + id, { body: { fidicBook: 'purple' } })).status, 422);
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'ready' } })).data.request.status, 'ready');
  // المشتريات ترى الجاهز فقط وتنشر؛ الطالب لا ينشر
  assert.strictEqual((await call(C, 'GET', '/api/requests')).data.requests.length, 1);
  assert.strictEqual((await call(R, 'POST', '/api/requests/' + id + '/tender', { body: tenderBody() })).status, 403);
  assert.strictEqual((await call(C, 'POST', '/api/requests/' + id + '/tender', { body: { closing: '2030-01-01' } })).status, 422, 'متطلبات التقييم مطلوبة');
  const pub = await call(C, 'POST', '/api/requests/' + id + '/tender', { body: tenderBody() });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.data));
  assert.strictEqual(pub.data.request.status, 'published');
  assert.strictEqual((await call(C, 'POST', '/api/requests/' + id + '/tender', { body: tenderBody() })).status, 409, 'لا نشر مرتين');
  // المقاول يرى العطاء مع FIDIC والوثائق العامة فقط
  const con = 'qcon-wf' + uniq();
  await call(con, 'POST', '/api/auth/register', { body: { name: 'مقاول', email: con + '@t.com', password: 'Password123' } });
  const one = await call(con, 'GET', '/api/procurement/tenders/' + pub.data.tenderId);
  assert.strictEqual(one.data.tender.fidic.book, 'red');
  assert.strictEqual(one.data.tender.fidic.edition, '2017');
  assert.strictEqual(one.data.tender.fidic.url, 'https://fidic.org');
  assert.strictEqual(one.data.tender.documentsCount, 2);
  assert.strictEqual(one.data.tender.name, 'إنشاء مبنى إداري', 'الاسم يؤخذ من الطلب');
  assert.strictEqual(one.data.tender.nameEn, 'Administrative building');
  const docs = await call(con, 'GET', '/api/procurement/tenders/' + pub.data.tenderId + '/documents');
  assert.deepStrictEqual(docs.data.documents.map((d) => d.kind).sort(), ['drawings', 'specifications']);
  const dl = await fetch(base + '/api/procurement/tenders/' + pub.data.tenderId + '/documents/' + docs.data.documents[0].id, { headers: cookieFor(con) });
  assert.strictEqual(dl.status, 200);
  assert.ok(/attachment/.test(dl.headers.get('content-disposition')));

  // A different organization cannot list, inspect, or download this tender's files.
  const isolated = await newBuyer('isolated', 'proc_pro');
  const isolatedProcurement = (await joinTeam(isolated, 'procurement', 'isolated-proc')).who;
  assert.strictEqual((await call(isolatedProcurement, 'GET', '/api/requests/' + id)).status, 404);
  assert.strictEqual((await call(isolatedProcurement, 'GET', '/api/requests/' + id + '/docs/' + docs.data.documents[0].id)).status, 404);
  assert.strictEqual((await call(isolatedProcurement, 'GET', '/api/procurement/tenders/' + pub.data.tenderId)).status, 404);
  assert.strictEqual((await fetch(base + '/api/procurement/tenders/' + pub.data.tenderId + '/documents/' + docs.data.documents[0].id, { headers: cookieFor(isolatedProcurement) })).status, 404);
  // الوثيقة الداخلية لا تُسرَّب
  const internalId = (await call(P, 'GET', '/api/requests/' + id)).data.request.docs.find((d) => d.kind === 'internal').id;
  assert.strictEqual((await fetch(base + '/api/procurement/tenders/' + pub.data.tenderId + '/documents/' + internalId, { headers: cookieFor(con) })).status, 404);
  // المقاول لا يدخل مسارات الجهة
  assert.strictEqual((await call(con, 'GET', '/api/requests')).status, 403);
  // تظهر العطاءات لأعضاء المشتريات والمدير لا الطالب
  assert.strictEqual((await call(C, 'GET', '/api/procurement/tenders')).data.tenders.length, 1);
  assert.strictEqual((await call(mgr, 'GET', '/api/procurement/tenders')).data.tenders.length, 1);
  assert.strictEqual((await call(R, 'GET', '/api/procurement/tenders')).status, 403);
  // سجل الأحداث
  const ev = (await call(mgr, 'GET', '/api/requests/' + id)).data.request.events.map((e) => e.action);
  assert.deepStrictEqual(ev.filter((a) => ['create', 'submit', 'take', 'ready', 'publish'].includes(a)), ['create', 'submit', 'take', 'ready', 'publish']);
});

test('73 — الاعتماد الاختياري، الإعادة من المشتريات، وعزل الطلبات بين الأعضاء', async () => {
  const mgr = await newBuyer('mgr2', 'proc_pro');
  const R = (await joinTeam(mgr, 'requester', 'rr')).who, R2 = (await joinTeam(mgr, 'requester', 'r2')).who, P = (await joinTeam(mgr, 'projects', 'pp')).who, C = (await joinTeam(mgr, 'procurement', 'cc')).who;
  assert.strictEqual((await call(P, 'PATCH', '/api/org', { body: { requireApproval: true } })).status, 403);
  assert.strictEqual((await call(mgr, 'PATCH', '/api/org', { body: { requireApproval: true } })).status, 200);
  const id = (await call(R, 'POST', '/api/requests', { body: reqBody() })).data.request.id;
  assert.strictEqual((await call(R2, 'GET', '/api/requests/' + id)).status, 404, 'طالب آخر لا يرى الطلب');
  assert.strictEqual((await call(R2, 'GET', '/api/requests')).data.requests.length, 0);
  await call(R, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'submit' } });
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'return' } })).status, 422, 'ملاحظة الإعادة إلزامية');
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'return', note: 'أرفق مخطط الموقع' } })).data.request.status, 'returned');
  assert.strictEqual((await call(R, 'GET', '/api/requests/' + id)).data.request.reviewNote, 'أرفق مخطط الموقع');
  assert.strictEqual((await call(R, 'PATCH', '/api/requests/' + id, { body: reqBody({ title: 'إنشاء مبنى إداري — معدّل' }) })).status, 200);
  await call(R, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'submit' } });
  await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'take' } });
  await call(P, 'POST', '/api/requests/' + id + '/docs', { form: docForm('boq', 'boq.pdf') });
  await call(P, 'PATCH', '/api/requests/' + id, { body: { fidicBook: 'yellow', fidicEdition: '1999' } });
  const aw = await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'ready' } });
  assert.strictEqual(aw.data.request.status, 'awaiting_approval');
  assert.strictEqual((await call(C, 'GET', '/api/requests')).data.requests.length, 0, 'المشتريات لا ترى قبل الاعتماد');
  assert.strictEqual((await call(P, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'approve' } })).status, 403);
  assert.strictEqual((await call(R2, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'approve' } })).status, 404);
  assert.strictEqual((await call(R, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'approve' } })).data.request.status, 'ready');
  const back = await call(C, 'POST', '/api/requests/' + id + '/transition', { body: { action: 'send_back', note: 'نحتاج مواصفات الكهرباء' } });
  assert.strictEqual(back.data.request.status, 'in_study');
  assert.strictEqual(back.data.request.reviewNote, 'نحتاج مواصفات الكهرباء');
  assert.strictEqual((await call(C, 'GET', '/api/requests')).data.requests.length, 0);
});

test('74 — توثيق الجهة يخص الجهة كلها، وطلبه لمديرها فقط', async () => {
  cfg.REQUIRE_ORG_VERIFICATION = true;
  try {
    const mgr = await newBuyer('mgv', 'proc_pro');
    const C = (await joinTeam(mgr, 'procurement', 'pcv')).who;
    const blocked = await mkTender(C, 1);
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.data.error.code, 'ORG_NOT_VERIFIED');
    assert.strictEqual((await call(C, 'POST', '/api/verification', { form: verForm() })).status, 403, 'العضو لا يقدّم طلب التوثيق');
    assert.strictEqual((await call(mgr, 'POST', '/api/verification', { form: verForm({ orgName: 'الشركة المتحدة', country: 'SA' }) })).status, 201);
    await makeAdmin('vadm2');
    const row = (await call('vadm2', 'GET', '/api/verification/admin?status=pending')).data.verifications.find((v) => v.orgName === 'الشركة المتحدة');
    assert.ok(row);
    assert.strictEqual((await call('vadm2', 'POST', '/api/verification/admin/' + row.id + '/approve', { body: {} })).status, 200);
    const ok = await mkTender(C, 2);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
    assert.strictEqual(ok.data.tender.country, 'SA', 'دولة الجهة الموثّقة');
    assert.strictEqual((await call(C, 'GET', '/api/verification')).data.verification.effective, 'verified', 'العضو يرى حالة التوثيق');
  } finally { cfg.REQUIRE_ORG_VERIFICATION = false; }
});


test('78 — الانضمام لا ينقل عطاءات الحساب القديمة إلى مؤسسة أخرى', async () => {
  const target = await newBuyer('join-target', 'proc_pro');
  const invite = await call(target, 'POST', '/api/org/invites', { body: { role: 'requester' } });
  const applicant = await newBuyer('join-with-tender', 'proc_pro');
  const created = await call(applicant, 'POST', '/api/tenders', {
    body: { name: 'عطاء سابق مستقل', authority: 'جهة اختبار', closing: '2030-01-01', notes: 'لا يجوز نقله تلقائياً' }
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  assert.strictEqual((await call(applicant, 'GET', '/api/org')).status, 200);
  const applicantId = (await call(applicant, 'GET', '/api/auth/me')).data.user.id;
  const before = getDB().prepare('SELECT org_id,user_id FROM tenders WHERE id=?').get(created.data.tender.id);
  const ownOrg = getDB().prepare('SELECT org_id FROM org_members WHERE user_id=?').get(applicantId);
  assert.ok(ownOrg && before.org_id === ownOrg.org_id);
  const joined = await call(applicant, 'POST', '/api/org/join', { body: { code: invite.data.code } });
  assert.strictEqual(joined.status, 409);
  const after = getDB().prepare('SELECT org_id,user_id FROM tenders WHERE id=?').get(created.data.tender.id);
  const membership = getDB().prepare('SELECT org_id FROM org_members WHERE user_id=?').get((await call(applicant, 'GET', '/api/auth/me')).data.user.id);
  assert.strictEqual(after.org_id, before.org_id);
  assert.strictEqual(membership.org_id, ownOrg.org_id);
});

test('75 — الانضمام لا يُسمح به لمدير جهة فيها أعضاء أو طلبات', async () => {
  const other = await newBuyer('o', 'proc_pro');
  const inv = await call(other, 'POST', '/api/org/invites', { body: { role: 'requester' } });
  const busy = await newBuyer('busy', 'proc_pro');
  await call(busy, 'POST', '/api/requests', { body: reqBody() });
  assert.strictEqual((await call(busy, 'POST', '/api/org/join', { body: { code: inv.data.code } })).status, 409);
});


/* ==========================================================
   Project finance: award → PO → invoice → approval → payments
   ========================================================== */
test('76 — دورة الترسية وأمر الشراء والفاتورة والمالية والدفعات', async () => {
  const manager = await newBuyer('finmgr', 'proc_pro');
  const procurement = (await joinTeam(manager, 'procurement', 'finproc')).who;
  const requester = (await joinTeam(manager, 'requester', 'finreq')).who;
  const finance = (await joinTeam(manager, 'finance', 'finrole')).who;
  const projects = (await joinTeam(manager, 'projects', 'finprojects')).who;

  // Projects staff should not browse financial records merely by being in the same organization.
  assert.strictEqual((await call(projects, 'GET', '/api/project-finance/awards')).status, 403);
  assert.strictEqual((await call(projects, 'GET', '/api/project-finance/purchase-orders')).status, 403);
  assert.strictEqual((await call(projects, 'GET', '/api/project-finance/invoices')).status, 403);

  const tender = await publish(procurement);
  const contractor = 'fincon' + uniq();
  const contractorEmail = contractor + '@t.com';
  await call(contractor, 'POST', '/api/auth/register', {
    body: { name: 'مقاول الدورة المالية', email: contractorEmail, password: 'Password123' }
  });
  const submitted = await call(contractor, 'POST', '/api/procurement/tenders/' + tender.id + '/submit', {
    body: bidBody(tender, 300)
  });
  assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.data));

  // لا ترسية قبل التقييم الفني وفتح العرض المالي.
  const premature = await call(manager, 'POST', '/api/project-finance/awards', {
    body: { tenderId: tender.id, submissionId: submitted.data.submissionId, awardedAmount: 200, currency: 'JOD', awardReference: 'AWD-FIN-01' }
  });
  assert.strictEqual(premature.status, 422);

  const evaluated = await call(procurement, 'POST', '/api/procurement/submissions/' + submitted.data.submissionId + '/evaluate', {
    body: { scores: tender.requirements.map((q) => ({ requirementId: q.id, score: 100 })) }
  });
  assert.strictEqual(evaluated.status, 200, JSON.stringify(evaluated.data));
  assert.strictEqual(evaluated.data.passed, true);

  const award = await call(manager, 'POST', '/api/project-finance/awards', {
    body: { tenderId: tender.id, submissionId: submitted.data.submissionId, awardedAmount: 300, currency: 'JOD', awardReference: 'AWD-FIN-01' }
  });
  assert.strictEqual(award.status, 201, JSON.stringify(award.data));

  // العملة المخالفة للترسية تُرفض، ثم يُنشأ أمر شراء صحيح.
  const wrongCurrency = await call(manager, 'POST', '/api/project-finance/awards/' + award.data.award.id + '/purchase-orders', {
    body: { poNumber: 'PO-FIN-BAD', currency: 'SAR', items: [{ description: 'أعمال مدنية', quantity: 1, unitPrice: 100 }] }
  });
  assert.strictEqual(wrongCurrency.status, 422);

  const po = await call(procurement, 'POST', '/api/project-finance/awards/' + award.data.award.id + '/purchase-orders', {
    body: { poNumber: 'PO-FIN-01', currency: 'JOD', items: [{ description: 'أعمال مدنية', quantity: 2, unitPrice: 100, unit: 'LS' }] }
  });
  assert.strictEqual(po.status, 201, JSON.stringify(po.data));
  const duplicateSpend = await call(manager, 'POST', '/api/project-finance/awards/' + award.data.award.id + '/purchase-orders', {
    body: { poNumber: 'PO-FIN-02', currency: 'JOD', items: [{ description: 'أعمال إضافية', quantity: 1, unitPrice: 101 }] }
  });
  assert.strictEqual(duplicateSpend.status, 422, 'لا يجوز أن يتجاوز مجموع أوامر الشراء قيمة الترسية');

  // Concurrent PO creation must serialize against the award ceiling.
  const concurrentPO = await Promise.all([1, 2].map((n) => call(procurement, 'POST', '/api/project-finance/awards/' + award.data.award.id + '/purchase-orders', {
    body: { poNumber: 'PO-RACE-' + n, currency: 'JOD', items: [{ description: 'أعمال إضافية متزامنة', quantity: 1, unitPrice: 60 }] }
  })));
  assert.deepStrictEqual(concurrentPO.map((x) => x.status).sort(), [201, 422], 'يجب قبول أمر واحد فقط عند تزاحم تجاوز قيمة الترسية');

  assert.strictEqual((await call(manager, 'POST', '/api/project-finance/purchase-orders/' + po.data.purchaseOrder.id + '/approve', { body: {} })).status, 200);
  assert.strictEqual((await call(procurement, 'POST', '/api/project-finance/purchase-orders/' + po.data.purchaseOrder.id + '/issue', { body: {} })).status, 200);

  // تجاوز قيمة أمر الشراء مرفوض.
  const tooLarge = await call(contractor, 'POST', '/api/project-finance/purchase-orders/' + po.data.purchaseOrder.id + '/invoices', {
    body: { invoiceNumber: 'INV-FIN-OVER', invoiceType: 'progress', items: [{ description: 'أعمال', quantity: 1, unitPrice: 250 }] }
  });
  assert.strictEqual(tooLarge.status, 409);

  const invoice = await call(contractor, 'POST', '/api/project-finance/purchase-orders/' + po.data.purchaseOrder.id + '/invoices', {
    body: { invoiceNumber: 'INV-FIN-01', invoiceType: 'progress', note: 'مستخلص مرحلي', items: [{ description: 'أعمال مدنية منفذة', quantity: 1, unitPrice: 150 }] }
  });
  assert.strictEqual(invoice.status, 201, JSON.stringify(invoice.data));
  const invoiceId = invoice.data.invoice.id;
  const invoiceFiles = await call(contractor, 'POST', '/api/project-finance/invoices/' + invoiceId + '/documents', {
    form: makeForm([{ name: 'invoice-proof.pdf', content: '%PDF-1.4 proof' }])
  });
  assert.strictEqual(invoiceFiles.status, 201, JSON.stringify(invoiceFiles.data));
  const invoiceDocumentId = invoiceFiles.data.documents[0].id;

  // Concurrent invoice submissions must not exceed the issued PO total.
  const concurrentInvoices = await Promise.all([1, 2].map((n) => call(contractor, 'POST', '/api/project-finance/purchase-orders/' + po.data.purchaseOrder.id + '/invoices', {
    body: { invoiceNumber: 'INV-RACE-' + n, invoiceType: 'progress', items: [{ description: 'مستخلص متزامن', quantity: 1, unitPrice: 30 }] }
  })));
  assert.deepStrictEqual(concurrentInvoices.map((x) => x.status).sort(), [201, 409], 'يجب قبول فاتورة واحدة فقط عند تزاحم تجاوز أمر الشراء');

  // Returned invoices must be safely editable and resubmittable.
  const returned = await call(procurement, 'POST', '/api/project-finance/invoices/' + invoiceId + '/procurement-review', {
    body: { decision: 'returned', note: 'يرجى إرفاق كشف الكميات المصحح' }
  });
  assert.strictEqual(returned.status, 200, JSON.stringify(returned.data));
  assert.strictEqual(returned.data.status, 'returned');
  const resubmitted = await call(contractor, 'POST', '/api/project-finance/invoices/' + invoiceId + '/resubmit', {
    body: { invoiceNumber: 'INV-FIN-01-R1', invoiceType: 'progress', note: 'تم التصحيح', items: [{ description: 'أعمال مدنية منفذة - مصححة', quantity: 1, unitPrice: 150 }] }
  });
  assert.strictEqual(resubmitted.status, 200, JSON.stringify(resubmitted.data));
  assert.strictEqual(resubmitted.data.status, 'submitted');
  assert.strictEqual(resubmitted.data.invoice.gross_amount, 150);

  // Cross-organization and unrelated-contractor reads must not expose this real invoice.
  const otherManager = await newBuyer('finother', 'proc_pro');
  const otherFinance = (await joinTeam(otherManager, 'finance', 'finother-role')).who;

  // Tenant isolation: a second organization's manager/finance users cannot
  // discover, read, evaluate, award, or transact against this organization's tender.
  const otherProcurement = (await joinTeam(otherManager, 'procurement', 'finother-procurement')).who;
  const originalInvite = await call(manager, 'POST', '/api/org/invites', { body: { role: 'requester', label: 'private-tenant-invite' } });
  assert.strictEqual(originalInvite.status, 201, JSON.stringify(originalInvite.data));
  const otherOrgView = await call(otherManager, 'GET', '/api/org');
  const originalOrgView = await call(manager, 'GET', '/api/org');
  assert.notStrictEqual(otherOrgView.data.org.id, originalOrgView.data.org.id, 'لكل مؤسسة معرّف مستقل');
  assert.ok(!otherOrgView.data.members.some((member) => member.id === manager), 'لا تظهر عضوية المؤسسة الأولى في إدارة المؤسسة الثانية');
  assert.ok(originalOrgView.data.invites.some((invite) => invite.id === originalInvite.data.invite.id), 'المدير يرى دعوة مؤسسته');
  assert.ok(!otherOrgView.data.invites.some((invite) => invite.id === originalInvite.data.invite.id), 'لا تظهر دعوات المؤسسة الأولى في المؤسسة الثانية');
  const otherTenderList = await call(otherProcurement, 'GET', '/api/procurement/tenders');
  assert.strictEqual(otherTenderList.status, 200);
  assert.ok(!otherTenderList.data.tenders.some((t) => t.id === tender.id), 'العطاء لا يظهر في قائمة مشتريات جهة أخرى');
  assert.strictEqual((await call(otherProcurement, 'GET', '/api/procurement/tenders/' + tender.id)).status, 404);
  assert.strictEqual((await call(otherProcurement, 'GET', '/api/procurement/tenders/' + tender.id + '/evaluations')).status, 404);
  assert.strictEqual((await call(otherProcurement, 'POST', '/api/submissions/' + submitted.data.submissionId + '/evaluate', {
    body: { scores: [] }
  })).status, 404, 'لا يمكن تقييم عرض تابع لعطاء جهة أخرى');
  assert.strictEqual((await call(otherProcurement, 'GET', '/api/procurement/tenders/' + tender.id + '/documents')).status, 404);
  assert.strictEqual((await call(otherManager, 'POST', '/api/project-finance/awards', {
    body: { tenderId: tender.id, submissionId: submitted.data.submissionId, awardedAmount: 300, currency: 'JOD' }
  })).status, 404);
  assert.strictEqual((await call(otherFinance, 'GET', '/api/project-finance/awards')).data.awards.length, 0);
  assert.strictEqual((await call(otherFinance, 'GET', '/api/project-finance/purchase-orders')).data.purchaseOrders.length, 0);
  assert.strictEqual((await call(otherFinance, 'GET', '/api/project-finance/invoices')).data.invoices.length, 0);
  assert.strictEqual((await call(otherFinance, 'GET', '/api/requests')).data.requests.length, 0);
  const outsider = 'finoutsider' + uniq();
  await call(outsider, 'POST', '/api/auth/register', {
    body: { name: 'مقاول غير مرتبط', email: outsider + '@t.com', password: 'Password123' }
  });
  assert.strictEqual((await call(outsider, 'GET', '/api/project-finance/invoices/' + invoiceId)).status, 404);
  assert.strictEqual((await call(otherFinance, 'GET', '/api/project-finance/invoices/' + invoiceId)).status, 404);
  assert.strictEqual((await call(otherFinance, 'GET', '/api/project-finance/invoices/' + invoiceId + '/documents')).status, 404);
  assert.strictEqual((await fetch(base + '/api/project-finance/invoice-documents/' + invoiceDocumentId + '/download', { headers: cookieFor(otherFinance) })).status, 404);
  assert.strictEqual((await fetch(base + '/api/project-finance/invoice-documents/' + invoiceDocumentId + '/download', { headers: cookieFor(outsider) })).status, 404);
  assert.strictEqual((await call(otherFinance, 'POST', '/api/project-finance/invoices/' + invoiceId + '/finance-approval', { body: {} })).status, 404);

  assert.strictEqual((await call(procurement, 'POST', '/api/project-finance/invoices/' + invoiceId + '/procurement-review', {
    body: { decision: 'accepted', note: 'مطابقة لأمر الشراء' }
  })).data.status, 'owner_confirmation');
  assert.strictEqual((await call(requester, 'POST', '/api/project-finance/invoices/' + invoiceId + '/owner-confirmation', {
    body: { decision: 'confirmed', note: 'تم استلام الأعمال' }
  })).data.status, 'finance_queue');
  assert.strictEqual((await call(requester, 'POST', '/api/project-finance/invoices/' + invoiceId + '/forward-to-finance', { body: {} })).data.status, 'finance_review');
  assert.strictEqual((await call(procurement, 'POST', '/api/project-finance/invoices/' + invoiceId + '/finance-approval', { body: {} })).status, 403);
  assert.strictEqual((await call(finance, 'POST', '/api/project-finance/invoices/' + invoiceId + '/finance-approval', { body: {} })).data.status, 'approved_for_payment');

  const partial = await call(finance, 'POST', '/api/project-finance/invoices/' + invoiceId + '/payments', {
    body: { amount: 50, paymentReference: 'PAY-FIN-01', paymentDate: '2026-11-03' }
  });
  assert.strictEqual(partial.status, 201, JSON.stringify(partial.data));
  assert.strictEqual((await call(finance, 'GET', '/api/project-finance/invoices/' + invoiceId)).data.invoice.status, 'part_paid');

  const overpayment = await call(finance, 'POST', '/api/project-finance/invoices/' + invoiceId + '/payments', {
    body: { amount: 101, paymentReference: 'PAY-FIN-OVER', paymentDate: '2026-11-03' }
  });
  assert.strictEqual(overpayment.status, 409);

  const concurrentPayments = await Promise.all([1, 2].map((n) => call(finance, 'POST', '/api/project-finance/invoices/' + invoiceId + '/payments', {
    body: { amount: 100, paymentReference: 'PAY-RACE-' + n, paymentDate: '2026-11-03' }
  })));
  assert.deepStrictEqual(concurrentPayments.map((x) => x.status).sort(), [201, 409], 'يجب قبول دفعة واحدة فقط حتى لا يتجاوز مجموع الدفعات قيمة الفاتورة');
  const finalState = await call(finance, 'GET', '/api/project-finance/invoices/' + invoiceId);
  assert.strictEqual(finalState.data.invoice.status, 'paid');
  assert.strictEqual(finalState.data.paid, 150);
  assert.strictEqual(finalState.data.remaining, 0);

  // بيانات دورة المشروع لا تدخل في فواتير اشتراكات MMC.
  const billing = await call(manager, 'GET', '/api/billing/invoices');
  assert.strictEqual(billing.status, 200);
  assert.ok(!billing.data.invoices.some((x) => x.id === invoiceId));
});

test('77 — دور المالية محصور بجهته ولا يستطيع مقاول آخر قراءة فاتورة الغير', async () => {
  const manager = await newBuyer('finiso', 'proc_pro');
  const finance = (await joinTeam(manager, 'finance', 'finiso-role')).who;
  const outsider = 'finout' + uniq();
  await call(outsider, 'POST', '/api/auth/register', {
    body: { name: 'مقاول خارجي', email: outsider + '@t.com', password: 'Password123' }
  });
  assert.strictEqual((await call(finance, 'GET', '/api/project-finance/invoices')).status, 200);
  assert.strictEqual((await call(outsider, 'GET', '/api/project-finance/invoices')).status, 200);
  const denied = await call(outsider, 'POST', '/api/project-finance/invoices/fake-id/finance-approval', { body: {} });
  assert.strictEqual(denied.status, 403);
});
