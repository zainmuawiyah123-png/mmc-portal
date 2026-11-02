'use strict';
/**
 * نسخة احتياطية آمنة لقاعدة البيانات أثناء التشغيل.
 *
 *   node scripts/backup.js [--local-only] [--no-retention]
 *
 * لماذا VACUUM INTO وليس نسخ الملف؟
 *   نسخ portal.db بـ cp أثناء الكتابة يلتقط حالة غير متسقة (WAL + صفحات نصف مكتوبة).
 *   VACUUM INTO يطلب من SQLite نفسه كتابة نسخة متسقة في معاملة قراءة واحدة —
 *   آمنة تماماً والخادم يعمل. لا نستخدم fs.copyFile إطلاقاً.
 *
 * الخطوات:
 *   1. VACUUM INTO ملف مؤقت
 *   2. تحقق: نفتح النسخة ونشغّل integrity_check ونجمع عدّ الصفوف
 *   3. gzip + SHA-256
 *   4. رفع إلى backups/db/YYYY/MM/ (عند STORAGE_DRIVER=s3 و BACKUP_UPLOAD=true)
 *   5. سياسة استبقاء: آخر 7 يومية + 4 أسبوعية + 12 شهرية
 *   6. سجل كل محاولة (نجاح/فشل، الحجم، المدة) في audit_log + ملف السجل
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');

process.chdir(path.resolve(__dirname, '..'));
const config = require('../src/config');

const LOCAL_ONLY = process.argv.includes('--local-only');
const NO_RETENTION = process.argv.includes('--no-retention');

function tsCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}
function tsIso() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const TABLES = ['users', 'plans', 'subscriptions', 'tenders', 'files', 'requests', 'audit_log', 'project_awards', 'purchase_orders', 'purchase_order_items', 'project_invoices', 'project_invoice_items', 'project_invoice_reviews', 'project_payments', 'project_invoice_documents', 'project_audit_events'];

function countRows(db) {
  const out = {};
  for (const t of TABLES) {
    try { out[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; }
    catch (_) { out[t] = null; }
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  const log = { startedAt: new Date().toISOString(), steps: [], ok: false };

  console.log('');
  console.log('═══ نسخة احتياطية لقاعدة البيانات ═══');
  console.log('  القاعدة   :', config.DB_PATH);
  console.log('  محلي فقط  :', LOCAL_ONLY ? 'نعم' : 'لا');
  console.log('');

  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });

  const stamp = tsCompact();
  const plainName = 'portal-' + stamp + '.db';
  const tmpPath = path.join(config.BACKUP_DIR, '.' + plainName + '.tmp');
  const gzName = plainName + '.gz';
  const gzPath = path.join(config.BACKUP_DIR, gzName);

  // احذف أي بقايا من تشغيل فاشل سابق
  for (const p of [tmpPath, gzPath]) { try { fs.unlinkSync(p); } catch (_) {} }

  const src = new Database(config.DB_PATH, { readonly: true });

  // ---------- 1) VACUUM INTO ----------
  const t1 = Date.now();
  src.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  const vacuumMs = Date.now() - t1;
  console.log('  ✓ VACUUM INTO — نسخة متسقة (' + vacuumMs + ' ms)');
  log.steps.push({ step: 'vacuum', ms: vacuumMs, ok: true });

  // عدّ صفوف الأصل (نأخذه من الاتصال الحالي، لا من النسخة)
  const srcCounts = countRows(src);

  // ---------- 2) تحقق من النسخة ----------
  const copy = new Database(tmpPath, { readonly: true });
  const integrity = copy.prepare('PRAGMA integrity_check').get();
  const integrityOk = (integrity.integrity_check || integrity['integrity_check']) === 'ok';
  const copyCounts = countRows(copy);
  copy.close();
  src.close();

  const countsMatch = TABLES.every((t) => srcCounts[t] === copyCounts[t]);
  console.log('  ' + (integrityOk ? '✓' : '✗') + ' integrity_check: ' + (integrity.integrity_check || JSON.stringify(integrity)));
  console.log('  ' + (countsMatch ? '✓' : '✗') + ' عدّ الصفوف مطابق بين الأصل والنسخة');
  log.steps.push({ step: 'verify', integrityOk, countsMatch, counts: srcCounts });

  if (!integrityOk || !countsMatch) {
    fs.unlinkSync(tmpPath);
    throw new Error('فشل التحقق من النسخة — أُلغيت النسخة الاحتياطية');
  }

  // ---------- 3) gzip + checksum ----------
  const raw = fs.readFileSync(tmpPath);
  const rawSum = sha256(raw);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(gzPath, gz);
  fs.unlinkSync(tmpPath);
  const gzSum = sha256(gz);

  // ملف بيان بجانب النسخة — يسمح بالتحقق بلا قاعدة بيانات
  const manifest = {
    file: gzName,
    createdAt: new Date().toISOString(),
    plainBytes: raw.length,
    gzBytes: gz.length,
    ratio: +(gz.length / raw.length).toFixed(3),
    sha256Plain: rawSum,
    sha256Gz: gzSum,
    counts: srcCounts,
    schemaVersion: 'v5',
    storageDriver: config.STORAGE_DRIVER
  };
  fs.writeFileSync(gzPath + '.json', JSON.stringify(manifest, null, 2));

  console.log('  ✓ ضغط gzip: ' + (raw.length / 1024).toFixed(1) + ' ك.ب → ' + (gz.length / 1024).toFixed(1) + ' ك.ب' +
    ' (نسبة ' + (gz.length / raw.length * 100).toFixed(1) + '%)');
  console.log('  ✓ SHA-256: ' + gzSum.slice(0, 24) + '…');
  log.steps.push({ step: 'compress', plainBytes: raw.length, gzBytes: gz.length, sha256Gz: gzSum });

  // ---------- 4) رفع إلى السحابة ----------
  let uploadedKey = null;
  const shouldUpload = !LOCAL_ONLY && config.STORAGE_DRIVER === 's3' && config.BACKUP_UPLOAD;
  if (shouldUpload) {
    const s3 = require('../src/lib/storage/s3');
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    uploadedKey = config.BACKUP_PREFIX + '/' + yyyy + '/' + mm + '/' + gzName;

    const put = await s3.put(uploadedKey, gz, { mime: 'application/gzip', originalName: gzName });
    // تحقق: ننزّل ونقارن التجزئة
    const back = await s3.get(uploadedKey);
    const backSum = sha256(back);
    if (backSum !== gzSum) {
      throw new Error('نسخة السحابة لا تطابق المحلية (checksum mismatch) — ' + uploadedKey);
    }
    console.log('  ✓ رُفعت إلى: ' + uploadedKey + ' (تحقق checksum نجح)');
    log.steps.push({ step: 'upload', key: uploadedKey, bytes: gz.length, verified: true });

    // نرفع البيان أيضاً
    await s3.put(uploadedKey + '.json', Buffer.from(JSON.stringify(manifest, null, 2)), { mime: 'application/json' });
  } else {
    console.log('  ↷ لم تُرفع للسحابة (' +
      (LOCAL_ONLY ? '--local-only' : 'STORAGE_DRIVER=' + config.STORAGE_DRIVER) + ') — النسخة محلية فقط');
  }

  // ---------- 5) سياسة الاستبقاء ----------
  let pruned = { local: [], cloud: [] };
  if (!NO_RETENTION) {
    pruned = await applyRetention();
    if (pruned.local.length || pruned.cloud.length) {
      console.log('  ✓ استبقاء: حُذف ' + pruned.local.length + ' محلياً، ' + pruned.cloud.length + ' من السحابة');
    }
  }

  // ---------- 6) السجل ----------
  const durationMs = Date.now() - startedAt;
  const record = {
    ...manifest,
    ok: true,
    durationMs,
    uploadedKey,
    pruned
  };

  // سجل نصي متراكم سهل القراءة
  fs.appendFileSync(path.join(config.BACKUP_DIR, 'backup.log'),
    '[' + new Date().toISOString() + '] OK  ' + gzName + '  ' + (gz.length / 1024).toFixed(1) + 'KB  ' +
    durationMs + 'ms  ' + (uploadedKey || 'local-only') + '\n');

  fs.writeFileSync(path.join(config.BACKUP_DIR, 'last-backup.json'), JSON.stringify(record, null, 2));

  // سجل التدقيق — إن تعذّر الوصول للقاعدة لا نفشل النسخة
  try {
    const { getDB } = require('../src/db');
    const { audit } = require('../src/lib/audit');
    audit({
      action: 'backup', entity: 'db', entityId: gzName, actor: 'system', driver: config.STORAGE_DRIVER,
      detail: { bytes: gz.length, durationMs, uploadedKey, counts: srcCounts, sha256: gzSum }
    });
  } catch (_) {}

  console.log('');
  console.log('═══ الملخص ═══');
  console.log('  الملف    :', gzPath);
  console.log('  المدة    :', durationMs + ' ms');
  console.log('  الصفوف   :', JSON.stringify(srcCounts));
  console.log('');

  process.exit(0);
}

/**
 * سياسة الاستبقاء: آخر 7 يومية + 4 أسبوعية + 12 شهرية.
 * نصنّف كل نسخة حسب تاريخها، نحتفظ بالمجموعة المطلوبة، ونحذف الباقي.
 */
async function applyRetention() {
  const files = fs.readdirSync(config.BACKUP_DIR)
    .filter((f) => /^portal-\d{8}-\d{6}\.db\.gz$/.test(f))
    .map((f) => {
      const m = f.match(/^portal-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db\.gz$/);
      return {
        name: f,
        date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])),
        path: path.join(config.BACKUP_DIR, f)
      };
    })
    .sort((a, b) => b.date - a.date);   // الأحدث أولاً

  const keep = new Set();

  // آخر N يومية
  files.slice(0, config.BACKUP_KEEP_DAILY).forEach((f) => keep.add(f.name));

  // آخر N أسبوعية: نسخة واحدة لكل أسبوع ISO
  const seenWeek = new Set();
  for (const f of files) {
    const wk = isoWeek(f.date);
    if (!seenWeek.has(wk)) {
      seenWeek.add(wk);
      if (seenWeek.size <= config.BACKUP_KEEP_WEEKLY) keep.add(f.name);
    }
    if (seenWeek.size > config.BACKUP_KEEP_WEEKLY + 8) break;
  }

  // آخر N شهرية: نسخة واحدة لكل شهر
  const seenMonth = new Set();
  for (const f of files) {
    const mo = f.date.getUTCFullYear() + '-' + String(f.date.getUTCMonth() + 1).padStart(2, '0');
    if (!seenMonth.has(mo)) {
      seenMonth.add(mo);
      if (seenMonth.size <= config.BACKUP_KEEP_MONTHLY) keep.add(f.name);
    }
    if (seenMonth.size > config.BACKUP_KEEP_MONTHLY + 6) break;
  }

  const toDelete = files.filter((f) => !keep.has(f.name));
  const deleted = [];
  for (const f of toDelete) {
    try {
      fs.unlinkSync(f.path);
      try { fs.unlinkSync(f.path + '.json'); } catch (_) {}
      deleted.push(f.name);
    } catch (_) {}
  }

  // نفس السياسة على السحابة
  const cloudDeleted = [];
  if (config.STORAGE_DRIVER === 's3' && config.BACKUP_UPLOAD) {
    try {
      const s3 = require('../src/lib/storage/s3');
      const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
      // نجمع كل المفاتيح تحت البادئة ثم نطبّق نفس قاعدة الإبقاء على أسمائها
      const all = [];
      let token;
      for (let g = 0; g < 50; g++) {
        const res = await listCloud(s3, token);
        all.push(...res.objects);
        if (!res.isTruncated) break;
        token = res.nextToken;
      }
      const keepNames = new Set();
      const parsed = all
        .map((o) => {
          const m = o.Key.match(/portal-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db\.gz$/);
          return m ? { key: o.Key, name: m[0], date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.date - a.date);

      parsed.slice(0, config.BACKUP_KEEP_DAILY).forEach((o) => keepNames.add(o.name));
      const sw = new Set();
      for (const o of parsed) {
        const wk = isoWeek(o.date);
        if (!sw.has(wk)) { sw.add(wk); if (sw.size <= config.BACKUP_KEEP_WEEKLY) keepNames.add(o.name); }
      }
      const sm = new Set();
      for (const o of parsed) {
        const mo = o.date.getUTCFullYear() + '-' + String(o.date.getUTCMonth() + 1).padStart(2, '0');
        if (!sm.has(mo)) { sm.add(mo); if (sm.size <= config.BACKUP_KEEP_MONTHLY) keepNames.add(o.name); }
      }
      const drop = parsed.filter((o) => !keepNames.has(o.name)).map((o) => o.key);
      for (let i = 0; i < drop.length; i += 900) {
        const batch = drop.slice(i, i + 900);
        if (!batch.length) continue;
        await deleteCloudBatch(s3, batch);
        cloudDeleted.push(...batch);
      }
    } catch (e) {
      console.warn('  ! تعذّر تطبيق الاستبقاء على السحابة:', e.message);
    }
  }

  return { local: deleted, cloud: cloudDeleted };
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0');
}

async function listCloud(s3, token) {
  // نستخدم عميل S3 مباشرة عبر الوحدة (لا نعيد تنفيذ التوقيع)
  const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const cfg = { region: config.S3_REGION || 'auto', forcePathStyle: config.S3_FORCE_PATH_STYLE };
  if (config.S3_ENDPOINT) cfg.endpoint = config.S3_ENDPOINT;
  if (config.S3_ACCESS_KEY_ID) cfg.credentials = { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY };
  const c = new S3Client(cfg);
  const res = await c.send(new ListObjectsV2Command({
    Bucket: config.S3_BUCKET, Prefix: config.BACKUP_PREFIX + '/', ContinuationToken: token, MaxKeys: 1000
  }));
  return { objects: (res.Contents || []), isTruncated: res.IsTruncated, nextToken: res.NextContinuationToken };
}

async function deleteCloudBatch(s3, keys) {
  const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const cfg = { region: config.S3_REGION || 'auto', forcePathStyle: config.S3_FORCE_PATH_STYLE };
  if (config.S3_ENDPOINT) cfg.endpoint = config.S3_ENDPOINT;
  if (config.S3_ACCESS_KEY_ID) cfg.credentials = { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY };
  const c = new S3Client(cfg);
  await c.send(new DeleteObjectsCommand({
    Bucket: config.S3_BUCKET, Delete: { Objects: keys.map((k) => ({ Key: k })) }
  }));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('');
    console.error('✗ فشلت النسخة الاحتياطية:', e.message);
    try {
      fs.appendFileSync(path.join(config.BACKUP_DIR, 'backup.log'),
        '[' + new Date().toISOString() + '] FAIL ' + e.message + '\n');
    } catch (_) {}
    try {
      require('../src/lib/audit').audit({
        action: 'backup', entity: 'db', actor: 'system', ok: false, detail: { error: e.message }
      });
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = { main, applyRetention, countRows, TABLES };
