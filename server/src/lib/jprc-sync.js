'use strict';
/**
 * Read-only connector for the public Arabic JPRC tender list.
 * It imports only rows explicitly marked as offered and uses only public files
 * hosted on JPRC's official domain. Full tender copies remain behind supplier
 * registration and the issuer's payment process.
 */
const { getDB, uid } = require('../db');
const { isAllowedPublicDocumentUrl } = require('./public-tender-documents');

const LIST_URL = 'https://www.jopetrol.com.jo/ar/modules/tenders';
const ORIGIN = 'https://www.jopetrol.com.jo';
const HEADERS = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)' };

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : ' '; } catch (_) { return ' '; }
    })
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function htmlText(value, limit = 3000) {
  return decodeHtml(String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, limit);
}
function dateToISO(value) {
  const m = String(value || '').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function spanBySuffix(block, suffix) {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(block || '').match(new RegExp(`<span\\b[^>]*id=["'][^"']*${escaped}["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  return m ? htmlText(m[1], 800) : '';
}
function safeJprcUrl(raw, base = LIST_URL) {
  try {
    const url = new URL(raw, base);
    return isAllowedPublicDocumentUrl('jprc', url.toString()) ? url.toString() : null;
  } catch (_) { return null; }
}
function extractPublicDocuments(block, externalId) {
  const documents = [], seen = new Set();
  if (externalId === '153/2026') return documents; // القائمة والمرفق اختلفا في وصف النطاق؛ لا نعرض ملفاً قد يضلل المقاول.
  for (const match of String(block || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const url = safeJprcUrl(match[1]);
    if (!url || seen.has(url)) continue;
    const pathname = new URL(url).pathname;
    if (!/\.(?:pdf|zip|docx?|xlsx?|jpe?g|png|webp)$/i.test(pathname)) continue;
    const filename = decodeURIComponent(pathname.split('/').pop() || '').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' ').trim();
    const label = htmlText(filename, 240) || 'مرفق عام من مصفاة البترول';
    seen.add(url);
    documents.push({ label, url, availability: 'public-source-link' });
  }
  return documents;
}
function parseJPRCRows(html, today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date())) {
  const source = String(html || '');
  const anchors = [...source.matchAll(/<a\b[^>]*href=["']([^"']*\/Ar\/TendersDetails\/[^"']+)["'][^>]*>/gi)];
  const rows = [], seen = new Set();
  for (let i = 0; i < anchors.length; i++) {
    const match = anchors[i], end = anchors[i + 1] ? anchors[i + 1].index : source.length;
    const block = source.slice(match.index, end);
    const numberMatch = block.match(/class=["']tender-number["'][^>]*>([\s\S]*?)<\/span>/i);
    const externalId = htmlText(numberMatch && numberMatch[1], 80);
    const title = spanBySuffix(block, 'lblTitle');
    const publishedAt = dateToISO(spanBySuffix(block, 'lblTender_PublishDate'));
    const closingAt = dateToISO(spanBySuffix(block, 'lblTender_ExpiredhDate'));
    const copyPrice = spanBySuffix(block, 'Label8');
    const category = spanBySuffix(block, 'lblCategory');
    const sourceUrl = safeJprcUrl(match[1]);
    if (!externalId || !title || !closingAt || !sourceUrl || !/عطاءات\s+مطروحة/.test(category) || seen.has(externalId)) continue;
    seen.add(externalId);
    const subsidiary = externalId === '356/2026';
    const authority = subsidiary ? 'الشركة الأردنية لصناعة وتعبئة الغاز المسال' : 'مصفاة البترول الأردنية';
    const documents = extractPublicDocuments(block, externalId);
    const qualityNote = externalId === '153/2026'
      ? 'يوجد اختلاف بين وصف الإعلان ووصف المرفق؛ لم يُرفق الملف داخل MMC.'
      : subsidiary ? 'الإعلان منشور على بوابة المصفاة، لكن الجهة المبينة في المرفق هي شركة الغاز المسال الأردنية.' : null;
    const accessNotes = 'المرفقات العامة الظاهرة هي إعلان أو ملخص فقط. الحصول على نسخة العطاء الكاملة يتطلب التسجيل في بوابة الموردين لدى الجهة وسداد الرسوم المعلنة عبر EFAWATEERCOM.';
    const summary = ['سعر النسخة: ' + (copyPrice || 'غير مذكور'), accessNotes, qualityNote].filter(Boolean).join(' · ');
    const deadline = Date.parse(closingAt + 'T00:00:00+03:00');
    rows.push({
      id: externalId, title: title.slice(0, 300), authority, country: 'JO', sector: 'الطاقة والمشتقات النفطية',
      tenderNumber: externalId, summary: summary.slice(0, 3000), publishedAt, closingAt,
      sourceUrl, applicationUrl: null, status: closingAt < today ? 'closed' : 'open', language: 'ar',
      details: { copyPrice: copyPrice || null, category, accessNotes, qualityNote, documents: documents.map(d => d.label) }, documents
    });
    void deadline;
  }
  return rows;
}
async function syncJPRC() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
  let html;
  try {
    const response = await fetch(LIST_URL, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error('JPRC returned HTTP ' + response.status);
    if (response.url && !safeJprcUrl(response.url, LIST_URL)) throw new Error('JPRC list redirected outside its official domain.');
    html = await response.text();
  } finally { clearTimeout(timer); }
  const rows = parseJPRCRows(html);
  if (!rows.length) throw new Error('JPRC loaded but no recognizable offered tender rows were found; existing records were left unchanged.');
  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
    VALUES (@rowId,'jprc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
    ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,
    sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
    closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,language=excluded.language,
    details_json=excluded.details_json,updated_at=unixepoch()`);
  const docUpsert = db.prepare(`INSERT INTO tender_opportunity_public_documents (id,opportunity_id,label,document_url,availability)
    VALUES (@id,@opportunityId,@label,@documentUrl,@availability)
    ON CONFLICT(opportunity_id,document_url) DO UPDATE SET label=excluded.label,availability=excluded.availability`);
  const tx = db.transaction(items => {
    let added = 0, updated = 0, documentsFound = 0;
    for (const row of items) {
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jprc', row.id);
      upsert.run({ rowId: old ? old.id : uid('opp_'), externalId: row.id, title: row.title, authority: row.authority,
        country: row.country, sector: row.sector, tenderNumber: row.tenderNumber, summary: row.summary,
        publishedAt: row.publishedAt, closingAt: row.closingAt, sourceUrl: row.sourceUrl,
        applicationUrl: row.applicationUrl, status: row.status, language: row.language, detailsJson: JSON.stringify(row.details) });
      const opportunityId = old ? old.id : db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jprc', row.id).id;
      if (old) updated++; else added++;
      for (const doc of row.documents) {
        docUpsert.run({ id: uid('oppdoc_'), opportunityId, label: doc.label, documentUrl: doc.url, availability: doc.availability });
        documentsFound++;
      }
    }
    return { added, updated, documentsFound };
  });
  return { ...tx(rows), received: rows.length, normalized: rows.length, source: 'jprc', sourceUrl: LIST_URL, firstPageOnly: true };
}
module.exports = { LIST_URL, parseJPRCRows, syncJPRC, dateToISO, htmlText };
