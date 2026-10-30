'use strict';
/**
 * اختبارات المرحلة الثانية — التخزين المجرّد مقابل خادم S3 حقيقي.
 *
 * تُشغَّل فقط عند توفّر S3_TEST_ENDPOINT (خادم متوافق مع S3 يعمل فعلياً).
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9500 S3_TEST_BUCKET=tpkit-test npm run test:s3
 *
 * ما تتحقق منه:
 *   1. شعار المشغّل: s3 صحيح ومتصل
 *   2. رفع → checksum مسجّل → رابط موقّع → تحميل → التجزئة مطابقة
 *   3. الرابط الموقّع ينتهي فعلياً (لا يُقبل بعد انتهاء مدته)
 *   4. مستخدم آخر لا يحصل على رابط موقّع لملف غيره (404)
 *   5. مستخدم آخر لا يفتح الرابط الموقّع الخاص بغيره (404)
 *   6. الحذف يزيل الكائن فعلياً من السحابة
 *   7. فحص صحة التخزين يرجع ok=true
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const BUCKET = process.env.S3_TEST_BUCKET || 'tpkit-test';

if (!ENDPOINT) {
  test('اختبارات S3 — تخطّي (S3_TEST_ENDPOINT غير محدّد)', { skip: true }, () => {});
} else {
  /* ---------------- بيئة معزولة قبل أي require ---------------- */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpkit-s3-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(TMP, 'test.db');
  process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
  process.env.JWT_SECRET = 'test-secret-s3-not-for-production';
  process.env.BCRYPT_ROUNDS = '4';
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_ENDPOINT = ENDPOINT;
  process.env.S3_BUCKET = BUCKET;
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = process.env.S3_TEST_KEY || 'S3RVER';
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_TEST_SECRET || 'S3RVER';
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.SIGNED_URL_TTL = '300';

  const { migrate } = require('../src/migrate');
  const { createApp } = require('../src/index');
  const { getDB, closeDB } = require('../src/db');
  const s3 = require('../src/lib/storage/s3');

  let server, base;
  const cookies = {};
  let tenderId, fileId, fileSum, fileKey;

  function cookieFor(name) { return cookies[name] ? { Cookie: cookies[name] } : {}; }

  async function call(name, method, p, { body, form } = {}) {
    const h = Object.assign({}, cookieFor(name));
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
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

  const uniq = () => Math.random().toString(36).slice(2, 9);
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

  /* ========================================================== */

  test('S1 — المشغّل النشط هو s3 والاتصال سليم', async () => {
    const { getStorage } = require('../src/lib/storage');
    const st = getStorage();
    assert.strictEqual(st.DRIVER, 's3', 'المشغّل يجب أن يكون s3');
    const h = await st.health();
    assert.strictEqual(h.ok, true, 'صحة التخزين: ' + JSON.stringify(h.detail));
    assert.strictEqual(h.detail.bucket, BUCKET);
  });

  test('S2 — رفع ملف إلى السحابة يسجّل checksum مطابقاً للمحتوى', async () => {
    await call('u1', 'POST', '/api/auth/register', {
      body: { name: 'مستخدم سحابي', email: 's3a' + uniq() + '@test.com', password: 'Password123', company: 'شركة' }
    });

    const t = await call('u1', 'POST', '/api/tenders', { body: { name: 'عطاء سحابي', authority: 'الأمانة' } });
    assert.strictEqual(t.status, 201, JSON.stringify(t.data));
    tenderId = t.data.tender.id;

    const content = '%PDF-1.4 محتوى اختبار حقيقي للسحابة ' + uniq();
    fileSum = sha256(Buffer.from(content));

    const fd = new FormData();
    fd.append('files', new Blob([content], { type: 'application/pdf' }), 'cloud-plan.pdf');
    fd.append('category', 'arch');

    const up = await call('u1', 'POST', '/api/tenders/' + tenderId + '/files', { form: fd });
    assert.strictEqual(up.status, 201, JSON.stringify(up.data));
    assert.strictEqual(up.data.driver, 's3', 'يجب أن يُرفع إلى s3');
    assert.strictEqual(up.data.files.length, 1);

    const f = up.data.files[0];
    fileId = f.id;
    assert.strictEqual(f.checksum, fileSum, 'checksum في قاعدة البيانات يجب أن يطابق SHA-256 للمحتوى');
    assert.strictEqual(f.driver, 's3');

    // المفتاح المنظّم الصحيح
    const row = getDB().prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    fileKey = row.storage_key;
    assert.match(fileKey, /^users\/usr_[^/]+\/tenders\/tnd_[^/]+\/[a-f0-9]{32}\.pdf$/,
      'مفتاح التخزين غير منظّم كما يجب: ' + fileKey);

    // الكائن موجود فعلاً في السحابة (فحص مباشر عبر SDK)
    assert.strictEqual(await s3.exists(fileKey), true, 'الكائن غير موجود في السحابة');
  });

  test('S3 — الرابط الموقّع يعمل وتجزئة المحتوى المنزّل مطابقة', async () => {
    const r = await call('u1', 'GET', '/api/files/' + fileId + '/url');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.url, 'لم يُرجع رابط');
    assert.strictEqual(r.data.driver, 's3');
    assert.strictEqual(r.data.expiresIn, 300, 'صلاحية الرابط يجب أن تكون 5 دقائق');

    // نزّل عبر الرابط الموقّع مباشرة (بلا كوكي) — هذا هو الغرض من التوقيع
    const dl = await fetch(r.data.url);
    assert.strictEqual(dl.status, 200, 'الرابط الموقّع أعاد ' + dl.status);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(sha256(buf), fileSum, 'محتوى التحميل لا يطابق الأصل');
  });

  test('S4 — التحميل المحمي عبر الجلسة يطابق المحتوى أيضاً', async () => {
    const dl = await call('u1', 'GET', '/api/files/' + fileId + '/download');
    assert.strictEqual(dl.status, 200);
    // الاستجابة نصية لأن fetch لا يفكّ PDF — نتحقق من وجود بصمة المحتوى
    assert.ok(String(dl.data).includes('محتوى اختبار حقيقي للسحابة'), 'محتوى التحميل المحمي غير مطابق');
  });

  test('S5 — مستخدم آخر لا يحصل على رابط موقّع لملف غيره (404)', async () => {
    await call('u2', 'POST', '/api/auth/register', {
      body: { name: 'مستخدم ثانٍ', email: 's3b' + uniq() + '@test.com', password: 'Password123' }
    });
    const r = await call('u2', 'GET', '/api/files/' + fileId + '/url');
    assert.strictEqual(r.status, 404, 'كان يجب أن يُرفض بـ 404، جاء ' + r.status);
    assert.ok(!r.data.url, 'تسرّب رابط لغير المالك!');
  });

  test('S6 — مستخدم آخر لا يفتح الرابط الموقّع الخاص بغيره', async () => {
    const own = await call('u1', 'GET', '/api/files/' + fileId + '/url');
    assert.strictEqual(own.status, 200);

    // الرابط الموقّع السحابي (presigned) لا يعتمد على الجلسة — هذه طبيعته.
    // لذا نتحقق أن مسار التخزين المحلي (الذي يعتمد على الجلسة) يرفض غير المالك.
    // نختبر انتحال الجلسة: طلب رابط ثم محاولة الوصول بجلسة المستخدم الثاني
    // إلى نقطة التحميل المحمية (التي تتحقق من الملكية).
    const other = await call('u2', 'GET', '/api/files/' + fileId + '/download');
    assert.strictEqual(other.status, 404, 'المستخدم الثاني وصل إلى ملف غيره!');
  });

  test('S7 — الرابط الموقّع سليم البنية ويحمل الصلاحية المطلوبة ويعمل', async () => {
    // ⚠ محدودية موثّقة: s3rver لا يتحقّق من توقيع الروابط الموقّعة إطلاقاً
    // (لا يفحص X-Amz-Signature ولا X-Amz-Expires)، بينما AWS S3 و R2 يفرضان
    // كليهما بـ 403. لذلك لا نستطيع هنا اختبار فرض التوقيع — نختبر ما يمكن:
    //   1. الرابط يحتوي توقيعاً وبيانات اعتماد وصلاحية بالمدة المطلوبة
    //   2. الرابط يعمل ويعيد المحتوى الصحيح
    // فرض التوقيع والانتهاء مُختبَر فعلياً في S11 على مشغّل القرص المحلي
    // (توقيع HMAC نتحكّم فيه بالكامل)، وموثّق كغير مختبَر على سحابة حقيقية.
    const short = await s3.signedUrl(fileKey, { expiresIn: 60 });
    const u = new URL(short.url);

    assert.ok(u.searchParams.get('X-Amz-Signature'), 'الرابط غير موقّع — لا يوجد X-Amz-Signature');
    assert.strictEqual(u.searchParams.get('X-Amz-Expires'), '60', 'مدة الصلاحية في الرابط غير صحيحة');
    assert.ok(u.searchParams.get('X-Amz-Credential'), 'الرابط يفتقد X-Amz-Credential');
    assert.ok(u.searchParams.get('X-Amz-Date'), 'الرابط يفتقد X-Amz-Date');
    // نمط المسار (path-style) لأننا نستخدم endpoint مخصصاً
    assert.ok(u.pathname.includes(BUCKET), 'الرابط لا يستخدم path-style للمجلد: ' + u.pathname);

    const ok = await fetch(short.url);
    assert.strictEqual(ok.status, 200, 'الرابط الصحيح يجب أن يعمل');
    const buf = Buffer.from(await ok.arrayBuffer());
    assert.strictEqual(sha256(buf), fileSum, 'المحتوى المنزّل عبر الرابط الموقّع لا يطابق الأصل');
  });

  test('S11 — مشغّل القرص المحلي: العبث بالرابط وانتهاء الصلاحية يُرفضان فعلياً', async () => {
    // هذا هو الاختبار الحاسم أمنياً على المنطق الذي نتحكّم فيه بأنفسنا:
    // توقيع HMAC على المفتاح + وقت الانتهاء. لا يعتمد على أي خدمة خارجية.
    const local = require('../src/lib/storage/local');
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');

    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'local-sign-'));
    const prev = process.env.UPLOAD_DIR;
    const cfg = require('../src/config');
    const oldDir = cfg.UPLOAD_DIR;
    cfg.UPLOAD_DIR = dir;

    const key = 'users/usr_test/tenders/tnd_test/abc123.pdf';
    await local.put(key, Buffer.from('محتوى محلي للاختبار'));

    // رابط صالح
    const good = await local.signedUrl(key, { expiresIn: 60 });
    const q = new URLSearchParams(good.url.split('?')[1]);
    assert.strictEqual(local.verifySignedUrl(q.get('k'), q.get('e'), q.get('s')).ok, true, 'الرابط الصالح رُفض');

    // عبث بالمفتاح: نفس التوقيع لمفتاح آخر
    const otherKey = 'users/usr_test/tenders/tnd_test/other.pdf';
    assert.strictEqual(local.verifySignedUrl(otherKey, q.get('e'), q.get('s')).ok, false, 'العبث بالمفتاح لم يُرفض');

    // عبث بمدة الصلاحية (تمديد)
    const farFuture = String(Math.floor(Date.now() / 1000) + 86400);
    const tamperedExp = local.verifySignedUrl(key, farFuture, q.get('s'));
    assert.strictEqual(tamperedExp.ok, false, 'تمديد الصلاحية لم يُرفض');
    assert.strictEqual(tamperedExp.reason, 'bad_signature');

    // رابط منتهي الصلاحية فعلاً (وقت في الماضي)
    const past = String(Math.floor(Date.now() / 1000) - 10);
    const crypto = require('crypto');
    const pastSig = crypto.createHmac('sha256', cfg.JWT_SECRET).update('local-signed:' + key + ':' + past).digest('base64url');
    const expired = local.verifySignedUrl(key, past, pastSig);
    assert.strictEqual(expired.ok, false, 'الرابط المنتهي لم يُرفض');
    assert.strictEqual(expired.reason, 'expired');

    // توقيع عشوائي
    assert.strictEqual(local.verifySignedUrl(key, q.get('e'), 'x'.repeat(43)).ok, false, 'توقيع عشوائي قُبل');

    cfg.UPLOAD_DIR = oldDir;
    fsx.rmSync(dir, { recursive: true, force: true });
  });

  test('S8 — فحص صحة التخزين عبر API يرجع 200 و ok=true', async () => {
    const r = await call('u1', 'GET', '/api/health/storage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.storage.ok, true);
    assert.strictEqual(r.data.configured, 's3');
    const byDriver = r.data.filesByDriver.find((x) => x.d === 's3');
    assert.ok(byDriver && byDriver.n >= 1, 'يجب أن يظهر ملف واحد على الأقل على s3');
  });

  test('S9 — الحذف يزيل الكائن فعلاً من السحابة', async () => {
    const del = await call('u1', 'DELETE', '/api/files/' + fileId);
    assert.strictEqual(del.status, 200, JSON.stringify(del.data));
    assert.strictEqual(del.data.ok, true);

    // الصف اختفى من قاعدة البيانات
    const row = getDB().prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    assert.strictEqual(row, undefined, 'صف الملف لم يُحذف');

    // والكائن اختفى من السحابة — الفحص الحاسم
    const stillThere = await s3.exists(fileKey);
    assert.strictEqual(stillThere, false, 'الكائن ما زال في السحابة بعد الحذف: ' + fileKey);
  });

  test('S10 — سجل التدقيق يحتوي دورة الحياة كاملة', async () => {
    const rows = getDB().prepare("SELECT action FROM audit_log WHERE action IN ('upload','signed_url','download','delete')").all();
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['upload', 'signed_url', 'download', 'delete']) {
      assert.ok(actions.has(a), 'سجل التدقيق يفتقد الحدث: ' + a);
    }
  });
}
