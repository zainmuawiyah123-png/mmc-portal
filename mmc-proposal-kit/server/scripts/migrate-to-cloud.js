'use strict';
/**
 * ترحيل الملفات من القرص المحلي إلى التخزين السحابي (S3/R2/MinIO).
 *
 *   node scripts/migrate-to-cloud.js [--dry-run] [--delete-local] [--limit=50]
 *
 * الضمانات:
 *   1. idempotent  — إعادة التشغيل لا ترفع ما رُفع بالفعل ولا تُكرّر الصفوف.
 *   2. تحقق checksum — بعد الرفع نُنزّل الكائن من السحابة ونقارن SHA-256.
 *   3. لا حذف محلي تلقائي — --delete-local صريح، وبعد التحقق فقط.
 *   4. سجل كامل — كل ملف يُسجَّل نجاحاً أو فشلاً في ملف تقرير وفي audit_log.
 *
 * متطلبات: STORAGE_DRIVER=s3 + مفاتيح S3 صحيحة. لن يعمل مع local.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.chdir(path.resolve(__dirname, '..'));
const config = require('../src/config');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith('--' + name));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return true;
}

const DRY_RUN = arg('dry-run', false) === true;
const DELETE_LOCAL = arg('delete-local', false) === true;
const LIMIT = Number(arg('limit', 0)) || 0;

const { getDB, closeDB } = require('../src/db');
const { migrate } = require('../src/migrate');
const S = require('../src/lib/storage');
const { audit } = require('../src/lib/audit');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function main() {
  const startedAt = Date.now();
  console.log('');
  console.log('═══ ترحيل الملفات إلى التخزين السحابي ═══');
  console.log('  المشغّل النشط :', config.STORAGE_DRIVER);
  console.log('  المجلد المحلي :', config.UPLOAD_DIR);
  console.log('  dry-run       :', DRY_RUN ? 'نعم (لن يُرفع شيء)' : 'لا');
  console.log('  delete-local  :', DELETE_LOCAL ? 'نعم (بعد التحقق)' : 'لا');
  console.log('');

  if (config.STORAGE_DRIVER !== 's3') {
    console.error('✗ الترحيل يحتاج STORAGE_DRIVER=s3. المشغّل الحالي: ' + config.STORAGE_DRIVER);
    process.exit(1);
  }

  migrate(config.DB_PATH);
  const db = getDB();
  const s3 = require('../src/lib/storage/s3');

  // فحص الاتصال قبل أي عمل — لا نبدأ ترحيلاً على خدمة غير متاحة
  const h = await s3.health();
  console.log('  صحة السحابة  :', h.ok ? '✓ متصلة' : '✗ ' + JSON.stringify(h.detail));
  if (!h.ok) {
    console.error('✗ لا يمكن الوصول إلى التخزين السحابي. أوقفنا الترحيل بلا أي تغيير.');
    process.exit(1);
  }

  // نأخذ الملفات التي لم تُرحَّل بعد (أو على قرص محلي)
  let rows = db.prepare(`
    SELECT * FROM files
    WHERE COALESCE(storage_driver,'local') = 'local'
       OR migrated_at IS NULL
    ORDER BY uploaded_at
  `).all();
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log('  ملفات مرشحة  :', rows.length);
  console.log('');

  const report = { startedAt: new Date().toISOString(), total: rows.length, succeeded: [], failed: [], skipped: [], deletedLocal: [] };

  for (const f of rows) {
    const key = f.storage_key || f.rel_path;
    const label = f.name + '  [' + key + ']';

    // مسار القرص المحلي الفعلي: في v4 كان rel_path = <uid>/<tid>/<name>
    const localPath = path.resolve(config.UPLOAD_DIR, f.rel_path || key);

    if (!fs.existsSync(localPath)) {
      // قد يكون رُفع سابقاً ونُزع محلياً — نتحقق من السحابة قبل اعتباره مفقوداً
      const inCloud = await s3.exists(key).catch(() => false);
      if (inCloud) {
        if (!DRY_RUN) {
          db.prepare("UPDATE files SET storage_key=?, storage_driver='s3', migrated_at=unixepoch() WHERE id=?")
            .run(key, f.id);
        }
        report.skipped.push({ id: f.id, key, reason: 'موجود في السحابة مسبقاً، لا ملف محلي' });
        console.log('  ↷ موجود سحابياً — تخطّي:', label);
      } else {
        report.failed.push({ id: f.id, key, error: 'الملف غير موجود لا محلياً ولا سحابياً' });
        console.log('  ✗ مفقود في المصدرين:', label);
      }
      continue;
    }

    const buffer = fs.readFileSync(localPath);
    const localSum = sha256(buffer);

    // إن كان checksum مسجّلاً مسبقاً يجب أن يطابق — يكشف تلفاً قبل الرفع
    if (f.checksum_sha256 && f.checksum_sha256 !== localSum) {
      report.failed.push({ id: f.id, key, error: 'checksum المحلي لا يطابق المسجّل في قاعدة البيانات' });
      console.log('  ✗ checksum محلي مختلف:', label);
      continue;
    }

    if (DRY_RUN) {
      report.succeeded.push({ id: f.id, key, dryRun: true, checksum: localSum, bytes: buffer.length });
      console.log('  ○ [dry-run] سيُرفع:', label, '(' + buffer.length + ' بايت)');
      continue;
    }

    try {
      // 1) رفع
      await s3.put(key, buffer, { mime: f.mime, originalName: f.name });

      // 2) تحقق: نُنزّل الكائن من السحابة ونقارن التجزئة الفعلية
      const back = await s3.get(key);
      const cloudSum = sha256(back);
      if (cloudSum !== localSum) {
        report.failed.push({ id: f.id, key, error: 'checksum السحابي لا يطابق المحلي', localSum, cloudSum });
        console.log('  ✗ checksum سحابي مختلف:', label);
        await s3.delete(key).catch(() => {});
        continue;
      }

      // 3) تحديث قاعدة البيانات فقط بعد التحقق الناجح
      db.prepare("UPDATE files SET storage_key=?, storage_driver='s3', checksum_sha256=?, migrated_at=unixepoch() WHERE id=?")
        .run(key, cloudSum, f.id);

      audit({
        action: 'migrate', entity: 'file', entityId: f.id, actor: 'system', driver: 's3',
        detail: { key, bytes: buffer.length, checksum: cloudSum }
      });

      report.succeeded.push({ id: f.id, key, checksum: cloudSum, bytes: buffer.length });

      // 4) حذف المحلي فقط عند الطلب الصريح وبعد التحقق
      if (DELETE_LOCAL) {
        try {
          fs.unlinkSync(localPath);
          report.deletedLocal.push({ id: f.id, key, path: localPath });
        } catch (e) {
          report.failed.push({ id: f.id, key, error: 'نُقل بنجاح لكن تعذّر حذف الملف المحلي: ' + e.message });
        }
      }

      console.log('  ✓ نُقل وتحقق:', label, '(' + buffer.length + ' بايت)' + (DELETE_LOCAL ? ' — حُذف المحلي' : ''));
    } catch (err) {
      report.failed.push({ id: f.id, key, error: err.name + ': ' + err.message });
      console.log('  ✗ فشل:', label, '—', err.message);
      audit({ action: 'migrate', entity: 'file', entityId: f.id, actor: 'system', driver: 's3', ok: false, detail: { key, error: err.message } });
    }
  }

  // تقرير
  const dir = path.join(config.BACKUP_DIR, 'migration-reports');
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, 'migrate-' + ts() + '.json');
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log('═══ الملخص ═══');
  console.log('  نجح     :', report.succeeded.length);
  console.log('  فشل     :', report.failed.length);
  console.log('  تخطّي   :', report.skipped.length);
  console.log('  حُذف محلياً:', report.deletedLocal.length);
  console.log('  المدة   :', report.durationMs + ' ms');
  console.log('  التقرير :', reportPath);
  console.log('');

  closeDB();
  process.exit(report.failed.length ? 2 : 0);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
