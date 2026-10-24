'use strict';
/**
 * مشغّل التخزين المحلي (Local Disk Driver).
 *
 * يخزّن الملفات تحت UPLOAD_DIR بنفس المفتاح المنظّم:
 *   uploads/users/<user_id>/tenders/<tender_id>/<uuid>.<ext>
 *
 * الروابط الموقّعة محلياً: رمز HMAC قصير العمر يُتحقَّق منه عند التحميل،
 * بنفس سلوك الرابط الموقّع السحابي حتى لا تختلف الواجهة بين المشغّلين.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { assertSafeKey, sha256 } = require('./index');

const DRIVER = 'local';

function absPath(key) {
  const safe = assertSafeKey(key);
  const root = path.resolve(config.UPLOAD_DIR);
  const full = path.resolve(root, safe);
  // حماية مزدوجة من path traversal بعد التطبيع
  if (full !== root && !full.startsWith(root + path.sep)) {
    const err = new Error('مسار ملف غير صالح.');
    err.status = 400; err.code = 'BAD_KEY'; err.expose = true;
    throw err;
  }
  return full;
}

/** رمز توقيع للرابط المحلي: base64url(HMAC-SHA256(path+exp)) */
function signToken(key, exp) {
  return crypto.createHmac('sha256', config.JWT_SECRET)
    .update('local-signed:' + key + ':' + exp)
    .digest('base64url');
}

async function put(key, buffer /*, meta */) {
  const full = absPath(key);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  // كتابة ذرّية: ملف مؤقت ثم إعادة تسمية — لا يبقى ملف نصف مكتوب عند الفشل
  const tmp = full + '.part-' + crypto.randomBytes(6).toString('hex');
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, full);
  return { key, driver: DRIVER, size: buffer.length, checksum: sha256(buffer) };
}

async function get(key) {
  return fsp.readFile(absPath(key));
}

function stream(key) {
  return fs.createReadStream(absPath(key));
}

async function del(key) {
  try { await fsp.unlink(absPath(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

async function exists(key) {
  try { await fsp.access(absPath(key)); return true; } catch (_) { return false; }
}

async function size(key) {
  try { return (await fsp.stat(absPath(key))).size; } catch (_) { return null; }
}

/**
 * رابط موقّع محلي: /api/storage/local?k=<key>&e=<exp>&s=<sig>
 * صالح لمدة قصيرة (افتراضي 5 دقائق) — يُتحقَّق منه في مسار التحميل.
 */
async function signedUrl(key, opts = {}) {
  const expiresIn = Math.max(30, Math.min(3600, Number(opts.expiresIn || config.SIGNED_URL_TTL)));
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = signToken(key, exp);
  const q = new URLSearchParams({ k: key, e: String(exp), s: sig });
  return { url: '/api/storage/local?' + q.toString(), expiresIn, driver: DRIVER };
}

/** يتحقق من توقيع الرابط المحلي — يُستخدم في مسار التحميل */
function verifySignedUrl(key, exp, sig) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const expected = signToken(key, e);
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

async function health() {
  try {
    await fsp.mkdir(config.UPLOAD_DIR, { recursive: true });
    const probe = path.join(config.UPLOAD_DIR, '.health-probe-' + crypto.randomBytes(4).toString('hex'));
    await fsp.writeFile(probe, 'ok');
    const back = await fsp.readFile(probe, 'utf8');
    await fsp.unlink(probe);
    return { ok: back === 'ok', driver: DRIVER, detail: { path: config.UPLOAD_DIR, writable: true } };
  } catch (e) {
    return { ok: false, driver: DRIVER, detail: { path: config.UPLOAD_DIR, error: e.message } };
  }
}

/** يحذف كل ملفات عطاء (يُستخدم عند حذف العطاء) */
async function deletePrefix(prefix) {
  const full = absPath(prefix);
  try { await fsp.rm(full, { recursive: true, force: true }); return 0; } catch (_) { return 0; }
}

module.exports = {
  DRIVER, put, get, stream, delete: del, exists, size,
  signedUrl, verifySignedUrl, health, deletePrefix, absPath
};
