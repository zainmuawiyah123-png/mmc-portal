'use strict';
/**
 * مشغّل S3 المتوافق (S3-compatible Driver) — AWS SDK v3.
 *
 * يعمل مع:
 *   • AWS S3            — بلا endpoint (يُستنتج من region)
 *   • Cloudflare R2     — S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
 *   • MinIO / SeaweedFS — S3_ENDPOINT=http://127.0.0.1:9000 + S3_FORCE_PATH_STYLE=true
 *   • Backblaze B2, Wasabi, DigitalOcean Spaces …
 *
 * الروابط الموقّعة: presigned GET قصير الصلاحية (افتراضي 300 ثانية).
 * الحجم يُحسب من ContentLength عند الرفع؛ checksum يُحسب محلياً قبل الرفع.
 */
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  HeadObjectCommand, HeadBucketCommand, DeleteObjectsCommand, ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../../config');
const { assertSafeKey, sha256 } = require('./index');

const DRIVER = 's3';
let _client = null;

function buildClient() {
  const cfg = {
    region: config.S3_REGION || 'auto',
    forcePathStyle: config.S3_FORCE_PATH_STYLE
  };
  // endpoint مخصص فقط عند تحديده — AWS S3 لا يحتاجه
  if (config.S3_ENDPOINT) cfg.endpoint = config.S3_ENDPOINT;
  if (config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY
    };
  }
  return new S3Client(cfg);
}

function client() {
  if (!_client) _client = buildClient();
  return _client;
}

function bucket() {
  if (!config.S3_BUCKET) {
    throw new Error('S3_BUCKET غير محدّد — مطلوب عند STORAGE_DRIVER=s3');
  }
  return config.S3_BUCKET;
}

function _reset() { _client = null; }

async function put(key, buffer, meta = {}) {
  const k = assertSafeKey(key);
  const checksum = sha256(buffer);
  await client().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: k,
    Body: buffer,
    ContentLength: buffer.length,
    ContentType: meta.mime || 'application/octet-stream',
    // S3 يتحقق من سلامة النقل عبر هذا الحقل إذا كانت الخدمة تدعمه
    ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
    Metadata: {
      'sha256': checksum,
      ...(meta.originalName ? { 'original-name': encodeURIComponent(String(meta.originalName)).slice(0, 200) } : {})
    }
  }));
  return { key: k, driver: DRIVER, size: buffer.length, checksum };
}

async function get(key) {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: assertSafeKey(key) }));
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

/** جسم الاستجابة قابل للتدفّق مباشرة — لا نحمّل الملف كاملاً في الذاكرة */
async function stream(key) {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: assertSafeKey(key) }));
  return { body: res.Body, contentType: res.ContentType, contentLength: res.ContentLength };
}

async function del(key) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: assertSafeKey(key) }));
}

async function exists(key) {
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: assertSafeKey(key) }));
    return true;
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return false;
    throw e;
  }
}

async function size(key) {
  try {
    const r = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: assertSafeKey(key) }));
    return r.ContentLength ?? null;
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return null;
    throw e;
  }
}

async function headMetadata(key) {
  try {
    return await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: assertSafeKey(key) }));
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return null;
    throw e;
  }
}

/** رابط موقّع مؤقت — افتراضي 300 ثانية (5 دقائق) */
async function signedUrl(key, opts = {}) {
  const expiresIn = Math.max(30, Math.min(3600, Number(opts.expiresIn || config.SIGNED_URL_TTL)));
  const url = await getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: assertSafeKey(key),
      ...(opts.downloadName
        ? { ResponseContentDisposition: 'attachment; filename="' + encodeURIComponent(opts.downloadName) + '"' }
        : {})
    }),
    { expiresIn }
  );
  return { url, expiresIn, driver: DRIVER };
}

async function health() {
  try {
    await client().send(new HeadBucketCommand({ Bucket: bucket() }));
    return {
      ok: true, driver: DRIVER,
      detail: { bucket: bucket(), endpoint: config.S3_ENDPOINT || 'aws', region: config.S3_REGION, pathStyle: config.S3_FORCE_PATH_STYLE }
    };
  } catch (e) {
    return {
      ok: false, driver: DRIVER,
      detail: {
        bucket: config.S3_BUCKET || null, endpoint: config.S3_ENDPOINT || 'aws',
        region: config.S3_REGION, error: e.name + ': ' + e.message,
        httpStatus: e.$metadata?.httpStatusCode || null
      }
    };
  }
}

/** حذف كل الملفات تحت بادئة (عند حذف عطاء) — على دفعات 1000 */
async function deletePrefix(prefix) {
  const p = assertSafeKey(prefix).replace(/\/+$/, '') + '/';
  let deleted = 0;
  let token;
  // حلقة محدودة الحجم — تتوقف إن لم تُرجع الخدمة محتوى
  for (let guard = 0; guard < 100; guard++) {
    const list = await client().send(new ListObjectsV2Command({
      Bucket: bucket(), Prefix: p, ContinuationToken: token, MaxKeys: 1000
    }));
    const objects = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (!objects.length) break;
    await client().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: objects } }));
    deleted += objects.length;
    if (!list.IsTruncated) break;
    token = list.NextContinuationToken;
  }
  return deleted;
}

module.exports = {
  DRIVER, put, get, stream, delete: del, exists, size, headMetadata,
  signedUrl, health, deletePrefix, _reset
};
