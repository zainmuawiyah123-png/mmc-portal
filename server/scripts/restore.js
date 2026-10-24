'use strict';
/**
 * استعادة قاعدة البيانات من نسخة احتياطية — مع تحقق كامل.
 *
 *   node scripts/restore.js --list                          عرض النسخ المتاحة
 *   node scripts/restore.js --latest --to=./data/restored.db
 *   node scripts/restore.js --file=portal-20261021-023000.db.gz --to=./data/restored.db
 *   node scripts/restore.js --latest --in-place --yes       استبدال القاعدة الحالية (خطِر)
 *
 * الضمانات:
 *   • لا نستعيد فوق القاعدة الحالية إلا بـ --in-place --yes صريحين.
 *   • نتحقق من SHA-256 مقابل البيان قبل فك الضغط.
 *   • نفتح النسخة المستعادة ونشغّل integrity_check ونقارن عدّ الصفوف في كل جدول
 *     مع البيان — نطبع جدولاً مطابقاً/مختلفاً.
 *   • عند --in-place نأخذ نسخة أمان من القاعدة الحالية قبل الاستبدال.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');

process.chdir(path.resolve(__dirname, '..'));
const config = require('../src/config');
const { TABLES } = require('./backup');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith('--' + name));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return true;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function listBackups() {
  if (!fs.existsSync(config.BACKUP_DIR)) return [];
  return fs.readdirSync(config.BACKUP_DIR)
    .filter((f) => /^portal-\d{8}-\d{6}\.db\.gz$/.test(f))
    .map((f) => {
      const p = path.join(config.BACKUP_DIR, f);
      const st = fs.statSync(p);
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(p + '.json', 'utf8')); } catch (_) {}
      return { name: f, path: p, bytes: st.size, mtime: st.mtime, manifest };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function main() {
  const startedAt = Date.now();

  if (arg('list', false)) {
    const all = listBackups();
    console.log('');
    console.log('═══ النسخ المتاحة في ' + config.BACKUP_DIR + ' ═══');
    if (!all.length) { console.log('  (لا نسخ)'); process.exit(1); }
    all.forEach((b, i) => {
      console.log('  ' + (i === 0 ? '★' : ' ') + ' ' + b.name +
        '  ' + (b.bytes / 1024).toFixed(1) + 'KB' +
        '  ' + (b.manifest ? JSON.stringify(b.manifest.counts) : '(بلا بيان)'));
    });
    console.log('');
    process.exit(0);
  }

  const target = arg('to', null);
  const inPlace = arg('in-place', false) === true;
  const confirmed = arg('yes', false) === true;
  const wanted = arg('file', null);

  if (inPlace && !confirmed) {
    console.error('✗ --in-place يستبدل القاعدة الحالية. أضف --yes للتأكيد.');
    process.exit(1);
  }
  if (!target && !inPlace) {
    console.error('✗ حدّد وجهة: --to=./data/restored.db  أو  --in-place --yes');
    process.exit(1);
  }

  // اختيار النسخة
  let chosen;
  if (wanted && wanted !== true) {
    const p = path.isAbsolute(wanted) ? wanted : path.join(config.BACKUP_DIR, wanted);
    if (!fs.existsSync(p)) { console.error('✗ النسخة غير موجودة: ' + p); process.exit(1); }
    chosen = { name: path.basename(p), path: p };
  } else {
    const all = listBackups();
    if (!all.length) { console.error('✗ لا توجد نسخ احتياطية في ' + config.BACKUP_DIR); process.exit(1); }
    chosen = all[0];
  }

  console.log('');
  console.log('═══ استعادة قاعدة البيانات ═══');
  console.log('  النسخة    :', chosen.name);
  console.log('  الوجهة    :', inPlace ? config.DB_PATH + ' (استبدال)' : target);
  console.log('');

  const gz = fs.readFileSync(chosen.path);
  const gzSum = sha256(gz);

  // ---------- 1) التحقق من التجزئة مقابل البيان ----------
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(chosen.path + '.json', 'utf8')); } catch (_) {}
  if (manifest && manifest.sha256Gz && manifest.sha256Gz !== gzSum) {
    console.error('✗ تجزئة الملف لا تطابق البيان — النسخة تالفة. توقّفنا.');
    console.error('   متوقع:', manifest.sha256Gz);
    console.error('   فعلي :', gzSum);
    process.exit(1);
  }
  console.log('  ✓ تجزئة gzip مطابقة' + (manifest ? ' للبيان' : ' (لا بيان — تخطّينا المقارنة)'));

  // ---------- 2) فك الضغط ----------
  const raw = zlib.gunzipSync(gz);
  const rawSum = sha256(raw);
  if (manifest && manifest.sha256Plain && manifest.sha256Plain !== rawSum) {
    console.error('✗ تجزئة القاعدة بعد فك الضغط لا تطابق البيان. توقّفنا.');
    process.exit(1);
  }
  console.log('  ✓ فك ضغط: ' + (raw.length / 1024).toFixed(1) + ' ك.ب');

  // ---------- 3) أخذ نسخة أمان قبل الاستبدال ----------
  const dest = inPlace ? config.DB_PATH : path.resolve(target);
  if (inPlace) {
    const safety = config.DB_PATH + '.before-restore-' + Date.now();
    if (fs.existsSync(config.DB_PATH)) {
      const cur = new Database(config.DB_PATH, { readonly: true });
      cur.exec(`VACUUM INTO '${safety.replace(/'/g, "''")}'`);
      cur.close();
      console.log('  ✓ نسخة أمان من القاعدة الحالية: ' + path.basename(safety));
    }
    // WAL/SHM قديمة تتعارض مع الملف الجديد
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(config.DB_PATH + ext); } catch (_) {} }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // اكتب في ملف مؤقت ثم انقل — لا قاعدة نصف مكتوبة عند الانقطاع
  const tmp = dest + '.restore-tmp-' + Date.now();
  fs.writeFileSync(tmp, raw);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(tmp, dest);
  console.log('  ✓ كُتب الملف: ' + dest);

  // ---------- 4) فتح والتحقق ----------
  const db = new Database(dest, { readonly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const integrityOk = (integrity.integrity_check || integrity['integrity_check']) === 'ok';
  console.log('  ' + (integrityOk ? '✓' : '✗') + ' integrity_check: ' + (integrity.integrity_check || JSON.stringify(integrity)));

  const actual = {};
  for (const t of TABLES) {
    try { actual[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; }
    catch (_) { actual[t] = null; }
  }
  const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  db.close();

  console.log('');
  console.log('  مقارنة عدد الصفوف (البيان مقابل المستعاد):');
  console.log('  ' + 'الجدول'.padEnd(18) + 'البيان'.padStart(10) + 'المستعاد'.padStart(12) + '  الحالة');
  console.log('  ' + '─'.repeat(52));

  let allMatch = true;
  for (const t of TABLES) {
    const expect = manifest && manifest.counts ? manifest.counts[t] : null;
    const got = actual[t];
    const ok = expect === null || expect === undefined ? (got !== null) : expect === got;
    if (!ok) allMatch = false;
    console.log('  ' + t.padEnd(18) +
      String(expect === null || expect === undefined ? '—' : expect).padStart(10) +
      String(got === null ? '—' : got).padStart(12) + '  ' + (ok ? '✓ مطابق' : '✗ مختلف'));
  }

  console.log('');
  console.log('  جداول موجودة: ' + userTables.length + ' — ' + userTables.join(', '));

  const durationMs = Date.now() - startedAt;
  const ok = integrityOk && allMatch;

  console.log('');
  console.log('═══ النتيجة ═══');
  console.log('  ' + (ok ? '✓ الاستعادة ناجحة والبيانات سليمة' : '✗ الاستعادة تمت لكن التحقق فشل — راجع الجدول أعلاه'));
  console.log('  المدة:', durationMs + ' ms');
  console.log('');

  try {
    require('../src/lib/audit').audit({
      action: 'restore', entity: 'db', entityId: chosen.name, actor: 'system', ok,
      detail: { dest, counts: actual, integrityOk, allMatch, inPlace }
    });
  } catch (_) {}

  process.exit(ok ? 0 : 3);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
