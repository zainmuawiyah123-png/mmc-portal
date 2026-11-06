'use strict';
/**
 * واجهة التخزين الموحّدة (Storage Abstraction).
 *
 * كل مشغّل (driver) ينفّذ نفس العقد تماماً:
 *   put(key, buffer, meta)  -> { key, driver, size, checksum }
 *   get(key)                -> Buffer
 *   stream(key)             -> Readable
 *   delete(key)             -> void
 *   exists(key)             -> boolean
 *   signedUrl(key, opts)    -> { url, expiresIn }
 *   health()                -> { ok, driver, detail }
 *
 * الاختيار عبر متغير البيئة STORAGE_DRIVER=local|s3.
 *
 *   STORAGE_DRIVER=local  → القرص المحلي (يعمل بلا أي مفاتيح سحابية)
 *   STORAGE_DRIVER=s3     → أي خدمة متوافقة مع S3: AWS S3، Cloudflare R2، MinIO، Backblaze B2 …
 *
 * مفتاح التخزين منظّم دائماً:
 *   users/<user_id>/tenders/<tender_id>/<uuid>.<ext>
 */
const crypto = require('crypto');
const path = require('path');
const config = require('../../config');

const ALLOWED_EXT = new Set([
  '.pdf', '.dwg', '.dxf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff',
  '.xlsx', '.xls', '.csv', '.docx', '.doc', '.txt', '.zip'
]);

/** الامتدادات الخطرة — تُرفض صراحةً حتى لو تسللت من القائمة البيضاء */
const BLOCKED_EXT = new Set([
  '.exe', '.sh', '.bat', '.cmd', '.com', '.scr', '.msi', '.jar', '.js', '.mjs', '.cjs',
  '.php', '.py', '.rb', '.pl', '.ps1', '.vbs', '.dll', '.so', '.app', '.html', '.htm',
  '.svg', '.xml', '.json', '.yaml', '.yml', '.env', '.pem', '.key'
]);

const CATEGORIES = new Set(['arch', 'struct', 'mep', 'tender', 'boq', 'other']);

function safeExt(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return ext.length > 12 ? '' : ext;
}

function displayName(originalName) {
  const base = path.basename(String(originalName || 'file')).replace(/[\\/\u0000-\u001f]/g, '_');
  return base.slice(0, 200) || 'file';
}

/** اسم تخزين عشوائي — لا يعتمد على اسم المستخدم إطلاقاً (يمنع التصادم والكشف) */
function makeStoredName(originalName) {
  return crypto.randomBytes(16).toString('hex') + safeExt(originalName);
}

/** المفتاح المنظّم: users/<user_id>/tenders/<tender_id>/<uuid>.<ext> */
function buildKey(userId, tenderId, storedName) {
  return ['users', userId, 'tenders', tenderId, storedName].join('/');
}

/** SHA-256 للمحتوى — يُخزَّن في قاعدة البيانات ويُستخدم للتحقق بعد الرفع والترحيل */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// استيراد كسول لوحدة الأخطاء: errors.js لا يعتمد على storage، فلا دورة حقيقية،
// لكن الاستيراد العلوي كان يجعل الاختبارات تُقلّد شكلاً مختلفاً للخطأ.
function appError(status, code, message) {
  const { AppError } = require('../errors');
  return new AppError(status, code, message);
}

function assertAllowed(originalName, size) {
  const ext = safeExt(originalName);
  if (!ext) {
    throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'الملف بدون امتداد. أضف الامتداد الصحيح (مثال: plan.pdf).');
  }
  if (BLOCKED_EXT.has(ext)) {
    throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع الملف ' + ext + ' غير مسموح لأسباب أمنية.');
  }
  if (!ALLOWED_EXT.has(ext)) {
    throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع الملف ' + ext + ' غير مدعوم. الأنواع المقبولة: PDF, DWG, DXF, JPG, PNG, XLSX, CSV, DOCX.');
  }
  if (size > config.MAX_FILE_BYTES) {
    throw appError(413, 'PAYLOAD_TOO_LARGE', 'حجم الملف (' + (size / 1048576).toFixed(1) + ' م.ب) يتجاوز الحد ' +
      (config.MAX_FILE_BYTES / 1048576).toFixed(0) + ' م.ب.');
  }
}

function assertSafeKey(key) {
  const k = String(key || '');
  if (!k || k.length > 512 || k.includes('..') || k.startsWith('/') || k.includes('\\') || /[\u0000-\u001f]/.test(k)) {
    throw appError(400, 'BAD_KEY', 'مفتاح تخزين غير صالح.');
  }
  return k;
}

function normalizeCategory(cat) {
  return CATEGORIES.has(cat) ? cat : 'other';
}

/** يمنع path traversal في أي مفتاح */
function assertSafeKey(key) {
  const k = String(key || '');
  if (!k || k.length > 512 || k.includes('..') || k.startsWith('/') || k.includes('\\') || /[\u0000-\u001f]/.test(k)) {
    throw appError(400, 'BAD_KEY', 'مفتاح تخزين غير صالح.');
  }
  return k;
}

let _driver = null;

/** يعيد المشغّل النشط (singleton) حسب STORAGE_DRIVER */
function getStorage() {
  if (_driver) return _driver;
  const name = String(config.STORAGE_DRIVER || 'local').toLowerCase();
  if (name === 's3') {
    _driver = require('./s3');
  } else if (name === 'local') {
    _driver = require('./local');
  } else {
    throw new Error('STORAGE_DRIVER غير معروف: "' + name + '". القيم المقبولة: local | s3');
  }
  return _driver;
}

/** للاختبارات: يسمح بإعادة التحميل بمشغّل مختلف داخل نفس العملية */
function _reset() { _driver = null; }

module.exports = {
  getStorage, _reset,
  ALLOWED_EXT, BLOCKED_EXT, CATEGORIES,
  safeExt, displayName, makeStoredName, buildKey, sha256,
  assertAllowed, normalizeCategory, assertSafeKey
};
