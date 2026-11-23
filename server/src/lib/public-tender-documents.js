'use strict';

const config = require('../config');
const { AppError } = require('./errors');

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 25000;
const SOURCE_HOSTS = Object.freeze({
  apc: ['arabpotash.com'],
  amman: ['gamtenders.gov.jo'],
  gam: ['gamtenders.gov.jo'],
  jpmc: ['jpmc.com.jo'],
  nepco: ['nepco.com.jo'],
  jepco: ['jepco.com.jo'],
  sepco: ['sepco.com.jo'],
  jprc: ['jopetrol.com.jo'],
  jppmc: ['jppmc.jo'],
  jordan_bromine: ['jordanbromine.com'],
  memr: ['memr.gov.jo'],
  mwi: ['mwi.gov.jo'],
  emrc: ['emrc.gov.jo'],
  unicef_jo: ['unicef.org'],
  unhcr_jo: ['unhcr.org'],
  joneps: ['joneps.gov.jo'],
  ungm: ['ungm.org'],
  worldbank: ['worldbank.org'],
  ted: ['ted.europa.eu','api.ted.europa.eu'],
  findatender: ['find-tender.service.gov.uk'],
  contractsfinder: ['contractsfinder.service.gov.uk'],
  sell2wales: ['sell2wales.gov.wales','api.sell2wales.gov.wales'],
  pcs: ['publiccontractsscotland.gov.uk','api.publiccontractsscotland.gov.uk']
});

const MIME_EXT = Object.freeze({
  'application/pdf': '.pdf',
  'application/x-pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/tiff': '.tif',
  'text/csv': '.csv',
  'text/plain': '.txt'
});
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.dwg', '.dxf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff',
  '.xlsx', '.xls', '.csv', '.docx', '.doc', '.txt', '.zip'
]);

function appError(status, code, message) {
  return new AppError(status, code, message);
}

function isAllowedPublicDocumentUrl(sourceKey, rawUrl) {
  const hosts = SOURCE_HOSTS[String(sourceKey || '').toLowerCase()];
  if (!hosts || !rawUrl) return false;
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const hostname = url.hostname.toLowerCase();
    return hosts.some(host => hostname === host || hostname.endsWith('.' + host));
  } catch (_) {
    return false;
  }
}

function urlExtension(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if ((host === 'ted.europa.eu' || host.endsWith('.ted.europa.eu')) && /\/(?:pdf|pdfs)\/?$/.test(pathname)) return '.pdf';
    const match = pathname.match(/\.([a-z0-9]{1,8})$/);
    if (!match) return '';
    const ext = '.' + match[1];
    return ALLOWED_EXTENSIONS.has(ext) ? ext : '';
  } catch (_) {
    return '';
  }
}

function fileInfo(rawUrl, rawMime = '', sourceKey = '') {
  const mime = String(rawMime || '').split(';')[0].trim().toLowerCase();
  const fromMime = MIME_EXT[mime] || '';
  const fromUrl = urlExtension(rawUrl);
  // For TED's /pdf endpoint, URL format is authoritative only as a candidate;
  // the response body is verified against the PDF signature before returning.
  if (String(sourceKey).toLowerCase() === 'ted' && fromUrl === '.pdf') {
    return { mime: 'application/pdf', ext: '.pdf' };
  }
  let ext = fromMime || fromUrl;
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'المرفق ليس من أنواع الملفات المسموح بتنزيلها عبر MMC.');
  }

  // لا نقبل صفحات دخول/HTML لمجرد أن عنوانها ينتهي بـ PDF.
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream' && !MIME_EXT[mime]) {
    const textMimeAllowed = (mime === 'text/plain' && ['.txt', '.csv'].includes(ext)) || (mime === 'text/csv' && ext === '.csv');
    if (!textMimeAllowed) throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'أعاد المصدر صفحة أو نوع محتوى غير قابل للتنزيل كوثيقة عطاء.');
  }
  if (fromMime && fromUrl && fromMime !== fromUrl && !(fromMime === '.jpg' && fromUrl === '.jpeg') && !(fromMime === '.jpeg' && fromUrl === '.jpg')) {
    ext = fromMime;
  }
  return { mime: mime && MIME_EXT[mime] ? mime : (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream'), ext };
}

function safeDocumentFilename(label, rawUrl, rawMime = '') {
  const info = fileInfo(rawUrl, rawMime);
  let base = String(label || 'وثيقة العطاء').trim();
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').slice(0, 100).trim();
  base = base.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  if (!base || /^(download|attachment|file|document)$/i.test(base)) base = 'وثيقة العطاء';
  return base + info.ext;
}

async function cancelBody(response) {
  try { if (response.body && typeof response.body.cancel === 'function') await response.body.cancel(); } catch (_) {}
}

async function downloadPublicDocument(sourceKey, rawUrl) {
  if (!isAllowedPublicDocumentUrl(sourceKey, rawUrl)) {
    throw appError(403, 'DOCUMENT_SOURCE_NOT_ALLOWED', 'لا يمكن تنزيل هذا الملف لأن نطاقه ليس ضمن مصادر العطاء الرسمية المعتمدة.');
  }

  const maxBytes = Math.max(1, Number(config.MAX_FILE_BYTES) || (25 * 1024 * 1024));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let current = new URL(String(rawUrl));
  // TED's /pdf endpoint serves the actual PDF; /pdfs may serve an HTML viewer.
  if (String(sourceKey).toLowerCase() === 'ted') {
    current.pathname = current.pathname.replace(/\/pdfs?\/?$/i, '/pdf');
  }
  let tedEmptyRetries = 0;
  // TED exposes both unsigned (/pdf) and signed (/pdfs) direct links.
  // If one representation returns an empty CMS response, try the other format
  // and the English rendition before reporting DOCUMENT_EMPTY.
  const tedFallbackUrls = [];
  if (String(sourceKey).toLowerCase() === 'ted') {
    const match = current.pathname.match(/^\/([a-z]{2})\/notice\/([^/]+)\/(pdf|pdfs)$/i);
    if (match) {
      const [, language, publicationNumber, format] = match;
      const otherFormat = format.toLowerCase() === 'pdf' ? 'pdfs' : 'pdf';
      for (const candidate of [
        `https://ted.europa.eu/${language}/notice/${publicationNumber}/${otherFormat}`,
        `https://ted.europa.eu/en/notice/${publicationNumber}/pdf`,
        `https://ted.europa.eu/en/notice/${publicationNumber}/pdfs`
      ]) {
        if (candidate !== current.toString() && !tedFallbackUrls.includes(candidate)) tedFallbackUrls.push(candidate);
      }
    }
  }
  const moveToTedFallback = () => {
    while (tedFallbackUrls.length) {
      const candidate = tedFallbackUrls.shift();
      if (isAllowedPublicDocumentUrl('ted', candidate)) {
        current = new URL(candidate);
        return true;
      }
    }
    return false;
  };

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (!isAllowedPublicDocumentUrl(sourceKey, current.toString())) {
        throw appError(403, 'DOCUMENT_REDIRECT_NOT_ALLOWED', 'أعاد المصدر رابطاً خارج نطاقه الرسمي؛ أوقف MMC التنزيل.');
      }
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/pdf,application/zip,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.*,image/*,text/csv,text/plain,application/octet-stream;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'
        },
        signal: controller.signal
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await cancelBody(response);
        if (!location || redirects === MAX_REDIRECTS) throw appError(502, 'DOCUMENT_REDIRECT_LIMIT', 'تعذّر الوصول إلى الملف العام بسبب تحويلات متكررة.');
        let next;
        try { next = new URL(location, current); } catch (_) { throw appError(502, 'DOCUMENT_BAD_REDIRECT', 'أعاد المصدر رابط تحويل غير صالح.'); }
        if (!isAllowedPublicDocumentUrl(sourceKey, next.toString())) {
          throw appError(403, 'DOCUMENT_REDIRECT_NOT_ALLOWED', 'أعاد المصدر رابطاً خارج نطاقه الرسمي؛ أوقف MMC التنزيل.');
        }
        current = next;
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        await cancelBody(response);
        throw appError(409, 'DOCUMENT_REQUIRES_VENDOR_ACCESS', 'يتطلب هذا الملف تسجيل مورد أو شراء وثائق لدى الجهة؛ لم يحاول MMC تجاوز ذلك.');
      }
      if (response.status === 404) {
        await cancelBody(response);
        if (String(sourceKey).toLowerCase() === 'ted' && moveToTedFallback()) {
          console.warn('[public-document] TED PDF format unavailable; trying official alternate link', JSON.stringify({ url: current.origin + current.pathname }));
          redirects--;
          continue;
        }
        throw appError(404, 'DOCUMENT_NO_LONGER_AVAILABLE', 'الملف غير متاح حالياً على المصدر الرسمي.');
      }
      if (!response.ok) {
        await cancelBody(response);
        throw appError(502, 'DOCUMENT_UPSTREAM_ERROR', 'تعذّر جلب الملف من المصدر الرسمي الآن.');
      }

      const responseMime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (String(sourceKey).toLowerCase() === 'ted' && responseMime &&
          !['application/pdf', 'application/x-pdf', 'application/octet-stream', 'binary/octet-stream'].includes(responseMime)) {
        await cancelBody(response);
        if (moveToTedFallback()) {
          console.warn('[public-document] TED endpoint returned non-PDF content; trying official PDF endpoint', JSON.stringify({
            status: response.status, contentType: responseMime, url: current.origin + current.pathname
          }));
          redirects--;
          continue;
        }
        throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'أعاد TED صفحة HTML بدلاً من ملف PDF.');
      }
      const type = fileInfo(current.toString(), response.headers.get('content-type') || '', sourceKey);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await cancelBody(response);
        throw appError(413, 'DOCUMENT_TOO_LARGE', 'حجم وثيقة المصدر يتجاوز الحد المسموح في MMC.');
      }
      if (!response.body) {
        if (String(sourceKey).toLowerCase() === 'ted' && moveToTedFallback()) {
          console.warn('[public-document] TED returned an empty response; trying official alternate PDF link', JSON.stringify({
            status: response.status,
            contentType: response.headers.get('content-type') || null,
            contentLength: response.headers.get('content-length') || null,
            url: current.origin + current.pathname
          }));
          redirects--;
          continue;
        }
        if (String(sourceKey).toLowerCase() === 'ted' && tedEmptyRetries < 1) {
          tedEmptyRetries++;
          console.warn('[public-document] TED empty response; retrying once', JSON.stringify({
            status: response.status,
            contentType: response.headers.get('content-type') || null,
            contentLength: response.headers.get('content-length') || null,
            contentEncoding: response.headers.get('content-encoding') || null,
            retry: tedEmptyRetries,
            url: current.origin + current.pathname
          }));
          redirects--;
          continue;
        }
        throw appError(502, 'DOCUMENT_EMPTY', 'لم يُرجع المصدر محتوى الملف.');
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) {
          controller.abort();
          throw appError(413, 'DOCUMENT_TOO_LARGE', 'حجم وثيقة المصدر يتجاوز الحد المسموح في MMC.');
        }
        chunks.push(buffer);
      }
      if (!size) {
        if (String(sourceKey).toLowerCase() === 'ted' && moveToTedFallback()) {
          console.warn('[public-document] TED returned zero bytes; trying official alternate PDF link', JSON.stringify({
            status: response.status,
            contentType: response.headers.get('content-type') || null,
            contentLength: response.headers.get('content-length') || null,
            receivedBytes: size,
            url: current.origin + current.pathname
          }));
          redirects--;
          continue;
        }
        if (String(sourceKey).toLowerCase() === 'ted' && tedEmptyRetries < 1) {
          tedEmptyRetries++;
          console.warn('[public-document] TED response body is empty; retrying once', JSON.stringify({
            status: response.status,
            contentType: response.headers.get('content-type') || null,
            contentLength: response.headers.get('content-length') || null,
            contentEncoding: response.headers.get('content-encoding') || null,
            receivedBytes: size,
            retry: tedEmptyRetries,
            url: current.origin + current.pathname
          }));
          redirects--;
          continue;
        }
        throw appError(502, 'DOCUMENT_EMPTY', 'الملف المستلم من المصدر فارغ.');
      }
      const buffer = Buffer.concat(chunks, size);
      // Never trust a .pdf URL or MIME header by itself. Reject HTML/login pages
      // and any response that does not contain a real PDF header near the start.
      if (type.ext === '.pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        if (String(sourceKey).toLowerCase() === 'ted' && moveToTedFallback()) {
          console.warn('[public-document] TED response lacked PDF signature; trying official alternate endpoint', JSON.stringify({
            url: current.origin + current.pathname, receivedBytes: size
          }));
          redirects--;
          continue;
        }
        throw appError(415, 'UNSUPPORTED_MEDIA_TYPE', 'لم يُرجع المصدر ملف PDF صالحاً؛ قد تكون الاستجابة صفحة HTML أو صفحة تسجيل دخول.');
      }
      return {
        buffer,
        mime: type.mime,
        extension: type.ext,
        filename: safeDocumentFilename('وثيقة العطاء', current.toString(), type.mime),
        finalUrl: current.toString()
      };
    }
    throw appError(502, 'DOCUMENT_REDIRECT_LIMIT', 'تعذّر الوصول إلى الملف العام بسبب تحويلات متكررة.');
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err && err.name === 'AbortError') throw appError(504, 'DOCUMENT_TIMEOUT', 'انتهت مهلة الاتصال بالمصدر الرسمي. أعد المحاولة لاحقاً.');
    throw appError(502, 'DOCUMENT_FETCH_FAILED', 'تعذّر جلب الملف من المصدر الرسمي الآن.');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SOURCE_HOSTS,
  isAllowedPublicDocumentUrl,
  urlExtension,
  fileInfo,
  safeDocumentFilename,
  downloadPublicDocument
};
