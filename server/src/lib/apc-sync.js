'use strict';
/**
 * Read-only connector for the public Arab Potash Company (APC) tender list.
 * It reads public listing/detail pages only: no login, document purchase, or bid submission.
 */
const { getDB, uid } = require('../db');
const { isAllowedPublicDocumentUrl } = require('./public-tender-documents');
const LIST_URL = 'https://arabpotash.com/EN/Modules/Tenders';
const ORIGIN = 'https://arabpotash.com';
const text = s => String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
function dmyToISO(v) {
  const m = String(v || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
const field = (body, label, next) => {
  const re = new RegExp(label + '\\s*:\\s*([\\s\\S]*?)\\s*(?=' + next + '|$)', 'i');
  const m = body.match(re);
  return m ? m[1].trim() : '';
};
function allowedApcUrl(raw, base = LIST_URL) {
  try {
    const url = new URL(raw, base);
    return isAllowedPublicDocumentUrl('apc', url.toString()) ? url.toString() : null;
  } catch (_) { return null; }
}
function parseApcRows(html, today) {
  const todayISO = today || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date());
  const out = [], seen = new Set();
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']*TendersDetails\?PID=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const pid = m[2];
    if (seen.has(pid)) continue;
    const body = text(m[3]).replace(/\s*Read More\s*$/i, '');
    const title = body.split(/\s+Purchase Date\s*:/i)[0].trim();
    if (!title) continue;
    const purchase = dmyToISO(field(body, 'Purchase Date', 'Closing date'));
    const closing = dmyToISO(field(body, 'Closing date', 'Copy Price'));
    const copyPrice = field(body, 'Copy Price', 'Bid Bond Value');
    const bond = field(body, 'Bid Bond Value', 'Vendor Qualifications');
    const quals = field(body, 'Vendor Qualifications', 'Remarks');
    const url = allowedApcUrl(m[1], LIST_URL) || (ORIGIN + '/En/TendersDetails?PID=' + encodeURIComponent(pid));
    const ref = (title.match(/(?:IFB|RFQ|RFP)\.?\s*(?:NO\.?|No)?\s*:?\s*(\d{6,}(?:\/[A-Za-z]+)?)/i) || [])[1];
    const intl = /international/i.test(quals);
    seen.add(pid);
    out.push({
      id: pid, title: title.slice(0, 300), authority: 'شركة البوتاس العربية / Arab Potash Company', country: 'JO', sector: null,
      tenderNumber: ref || pid,
      summary: ['سعر النسخة: ' + (copyPrice || '—'), 'كفالة دخول العطاء: ' + (bond || '—'), 'المؤهلات المطلوبة: ' + (quals || '—'),
        'تاريخ شراء الوثائق: ' + (purchase || '—')].join(' · '),
      publishedAt: purchase, closingAt: closing, sourceUrl: url, applicationUrl: null,
      status: closing && closing < todayISO ? 'closed' : 'open', language: intl ? 'en' : 'ar'
    });
  }
  return out;
}
function parseApcDetail(html, baseUrl) {
  const body = text(html);
  const purchase = field(body, 'Purchase Date', 'Closing date');
  const closing = field(body, 'Closing date', 'Copy Price');
  const copyPrice = field(body, 'Copy Price', 'Bid Bond Value');
  const bond = field(body, 'Bid Bond Value', 'Vendor Qualifications');
  const qualifications = field(body, 'Vendor Qualifications', 'Remarks');
  const remarks = field(body, 'Remarks', 'Read More');
  const details = {
    publicationDate: null,
    purchaseDate: dmyToISO(purchase),
    closingDate: dmyToISO(closing),
    copyPrice: copyPrice || null,
    bidBond: bond || null,
    qualifications: qualifications || null,
    remarks: remarks || null,
    source: 'official-detail'
  };
  const documents = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = allowedApcUrl(match[1], baseUrl);
    if (!url || seen.has(url)) continue;
    const label = text(match[2]) || 'وثيقة العطاء';
    const filePath = new URL(url).pathname;
    const looksLikeFile = /\.(?:pdf|dwg|dxf|jpe?g|png|webp|tiff?|xlsx?|docx?|txt|csv|zip)$/i.test(filePath);
    const looksLikeAttachment = /(download|attachment|tender document|document|تحميل|وثائق|مرفق)/i.test(label);
    if (!looksLikeFile && !looksLikeAttachment) continue;
    seen.add(url);
    documents.push({ label: label.slice(0, 240), url, availability: 'public-source-link' });
  }
  return { details, documents };
}
async function fetchApcDetail(url) {
  const safeUrl = allowedApcUrl(url, LIST_URL);
  if (!safeUrl) return null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(safeUrl, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)' },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return parseApcDetail(await response.text(), safeUrl);
  } catch (_) {
    return null;
  } finally { clearTimeout(timer); }
}
async function syncAPC() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  let html;
  try {
    const response = await fetch(LIST_URL, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error('APC returned HTTP ' + response.status);
    html = await response.text();
  } finally { clearTimeout(timer); }
  const rows = parseApcRows(html);
  if (!rows.length) throw new Error('APC page loaded but no recognizable tender rows were found; importer stopped without changing records.');

  const enriched = [];
  for (let i = 0; i < rows.length; i += 4) {
    const details = await Promise.all(rows.slice(i, i + 4).map(row => fetchApcDetail(row.sourceUrl)));
    rows.slice(i, i + 4).forEach((row, offset) => enriched.push({ ...row, detail: details[offset] }));
  }

  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
    VALUES (@rowId,'apc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
    ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,
    tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,
    source_url=excluded.source_url,status=excluded.status,language=excluded.language,
    details_json=COALESCE(excluded.details_json,tender_opportunities.details_json),updated_at=unixepoch()`);
  const documentUpsert = db.prepare(`INSERT INTO tender_opportunity_public_documents
    (id,opportunity_id,label,document_url,availability)
    VALUES (@id,@opportunityId,@label,@documentUrl,@availability)
    ON CONFLICT(opportunity_id,document_url) DO UPDATE SET label=excluded.label,availability=excluded.availability`);
  const tx = db.transaction(items => {
    let added = 0, updated = 0, documentsFound = 0, detailsReceived = 0;
    for (const row of items) {
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('apc', row.id);
      const detailJson = row.detail ? JSON.stringify(row.detail.details) : null;
      upsert.run({
        rowId: old ? old.id : uid('opp_'), externalId: row.id, title: row.title, authority: row.authority, country: row.country,
        sector: row.sector, tenderNumber: row.tenderNumber, summary: row.summary, publishedAt: row.publishedAt, closingAt: row.closingAt,
        sourceUrl: row.sourceUrl, applicationUrl: row.applicationUrl, status: row.status, language: row.language, detailsJson: detailJson
      });
      const opportunityId = old ? old.id : db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('apc', row.id).id;
      if (old) updated++; else added++;
      if (row.detail) {
        detailsReceived++;
        for (const doc of row.detail.documents) {
          documentUpsert.run({ id: uid('oppdoc_'), opportunityId, label: doc.label, documentUrl: doc.url, availability: doc.availability });
          documentsFound++;
        }
      }
    }
    return { added, updated, documentsFound, detailsReceived };
  });
  return { ...tx(enriched), received: rows.length, normalized: rows.length, source: 'apc', sourceUrl: LIST_URL };
}
module.exports = { parseApcRows, parseApcDetail, syncAPC, LIST_URL };
