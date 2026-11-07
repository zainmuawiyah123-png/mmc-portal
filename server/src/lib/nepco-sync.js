'use strict';
/**
 * Read-only connector for NEPCO's publicly rendered tender list.
 * The current list exposes notice metadata and detail links, but not direct
 * public tender files. The importer never invents attachments or bypasses JONEPS.
 */
const { getDB, uid } = require('../db');
const { isAllowedPublicDocumentUrl } = require('./public-tender-documents');

const LIST_URL = 'https://www.nepco.com.jo/en/Tenders.aspx';
const HEADERS = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)' };
function htmlText(value, limit = 3000) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function spanById(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html || '').match(new RegExp(`<span\\b[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  return match ? htmlText(match[1], 1800) : '';
}
function safeNepcoUrl(raw, base = LIST_URL) {
  try {
    const url = new URL(raw, base);
    return isAllowedPublicDocumentUrl('nepco', url.toString()) ? url.toString() : null;
  } catch (_) { return null; }
}
function parseNEPCORows(html, today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date())) {
  const source = String(html || ''), rows = [], seen = new Set();
  const refs = [...source.matchAll(/<span\b[^>]*id=["']ContentPlaceHolder1_tenders_tenderNo_(\d+)["'][^>]*>/gi)];
  for (const ref of refs) {
    const index = ref[1];
    const start = source.lastIndexOf('<div class="col-lg-6 tender-hover"', ref.index);
    const next = source.indexOf('<div class="col-lg-6 tender-hover"', ref.index + ref[0].length);
    const block = source.slice(start >= 0 ? start : ref.index, next >= 0 ? next : source.length);
    const externalId = spanById(block, 'ContentPlaceHolder1_tenders_tenderNo_' + index);
    const title = spanById(block, 'ContentPlaceHolder1_tenders_tenderDesc_' + index);
    const close = spanById(block, 'ContentPlaceHolder1_tenders_closeDate_' + index);
    const copyPrice = spanById(block, 'ContentPlaceHolder1_tenders_copyPrice_' + index);
    const link = block.match(/<a\b[^>]*href=["']([^"']*TenderPage\.aspx\?[^"']+)["'][^>]*>/i);
    const sourceUrl = link ? safeNepcoUrl(link[1], LIST_URL) : null;
    if (!externalId || !title || !/^\d{4}-\d{2}-\d{2}$/.test(close) || !sourceUrl || seen.has(externalId)) continue;
    const deadline = new Date(close + 'T00:00:00Z');
    if (!Number.isFinite(deadline.getTime()) || deadline.toISOString().slice(0, 10) !== close) continue;
    seen.add(externalId);
    const jonepsNotice = /JONEPS|نظام الشراء الإلكتروني الموحد/i.test(title);
    const accessNotes = jonepsNotice
      ? 'يذكر الإعلان أن الشروط والرسوم عبر JONEPS وeFAWATEERcom، وأن تقديم العرض إلكتروني على JONEPS وتسليم كفالة الدخول لدى NEPCO.'
      : 'القائمة لا تعرض ملفاً عاماً مباشراً. افتح التفاصيل الرسمية للتحقق من شروط الوثائق والتقديم؛ لا يتجاوز MMC التسجيل أو رسوم النسخ.';
    const summary = ['سعر نسخة الوثائق: ' + (copyPrice || 'غير مذكور'), accessNotes].join(' · ');
    rows.push({
      id: externalId, title: title.slice(0, 300), authority: 'شركة الكهرباء الوطنية (NEPCO)', country: 'JO',
      sector: 'الكهرباء والطاقة', tenderNumber: externalId, summary: summary.slice(0, 3000),
      publishedAt: null, closingAt: close, sourceUrl, applicationUrl: null,
      status: close < today ? 'closed' : 'open', language: /[\u0600-\u06FF]/.test(title) ? 'ar' : 'en',
      details: { copyPrice: copyPrice || null, accessNotes, hasPublicAttachment: false }
    });
  }
  return rows;
}
async function syncNEPCO() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
  let html;
  try {
    const response = await fetch(LIST_URL, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error('NEPCO returned HTTP ' + response.status);
    if (response.url && !safeNepcoUrl(response.url, LIST_URL)) throw new Error('NEPCO list redirected outside its official domain.');
    html = await response.text();
  } finally { clearTimeout(timer); }
  const rows = parseNEPCORows(html);
  if (!rows.length) throw new Error('NEPCO loaded but no recognizable tender cards were found; existing records were left unchanged.');
  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
    VALUES (@rowId,'nepco',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
    ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,
    sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
    closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,language=excluded.language,
    details_json=excluded.details_json,updated_at=unixepoch()`);
  const tx = db.transaction(items => {
    let added = 0, updated = 0;
    for (const row of items) {
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('nepco', row.id);
      upsert.run({ rowId: old ? old.id : uid('opp_'), externalId: row.id, title: row.title, authority: row.authority,
        country: row.country, sector: row.sector, tenderNumber: row.tenderNumber, summary: row.summary,
        publishedAt: row.publishedAt, closingAt: row.closingAt, sourceUrl: row.sourceUrl,
        applicationUrl: row.applicationUrl, status: row.status, language: row.language, detailsJson: JSON.stringify(row.details) });
      if (old) updated++; else added++;
    }
    return { added, updated };
  });
  return { ...tx(rows), received: rows.length, normalized: rows.length, source: 'nepco', sourceUrl: LIST_URL };
}
module.exports = { LIST_URL, parseNEPCORows, syncNEPCO, htmlText };
