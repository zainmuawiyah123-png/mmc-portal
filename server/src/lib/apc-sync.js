'use strict';
/**
 * Read-only connector for the public Arab Potash Company (APC) tender list.
 * It reads the public listing page only: no login, no document purchase, no bid submission.
 * The list is paged by an ASP.NET postback, so each run reads the first page, which holds the
 * newest tenders; the 6-hourly schedule keeps the directory current from there.
 */
const LIST_URL = 'https://arabpotash.com/EN/Modules/Tenders';
const ORIGIN = 'https://arabpotash.com';
const text = (s) => String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
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
    let url = ORIGIN + '/En/TendersDetails?PID=' + pid;
    try { const u = new URL(m[1], LIST_URL); if (u.origin === ORIGIN) url = u.toString(); } catch (_) {}
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

function parseApcDetail(html, pid, fallback = {}) {
  const body = text(html);
  const titleMatch = body.match(/Tender title and number:\s*(.*?)(?=\s*Purchase Date:)/i);
  const title = (titleMatch && titleMatch[1] || fallback.title || '').trim().slice(0,300);
  const purchaseDate = field(body, 'Purchase Date', 'Closing date');
  const closingDate = field(body, 'Closing date', 'Copy Price');
  const copyPrice = field(body, 'Copy Price', 'Bid Bond Value');
  const bidBond = field(body, 'Bid Bond Value', 'Vendor Qualifications');
  const qualifications = field(body, 'Vendor Qualifications', 'Remarks|Announcement|Tender Documents');
  const remarks = field(body, 'Remarks', 'Announcement|Tender Documents');
  const documents = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = text(m[2]);
    if (!/announcement|document|وثائق|اعلان|إعلان/i.test(label)) continue;
    try {
      const u = new URL(m[1], ORIGIN + '/En/TendersDetails?PID=' + encodeURIComponent(pid));
      if (u.protocol !== 'https:' || !(u.hostname === 'arabpotash.com' || u.hostname.endsWith('.arabpotash.com'))) continue;
      documents.push({label:label.slice(0,200),url:u.toString(),availability:'public-source-link'});
    } catch (_) {}
  }
  const detailUrl = ORIGIN + '/En/TendersDetails?PID=' + encodeURIComponent(pid);
  return {title, tenderNumber:fallback.tenderNumber || null, purchaseDate:dmyToISO(purchaseDate) || fallback.publishedAt || null,
    closingDate:dmyToISO(closingDate) || fallback.closingAt || null, copyPrice:copyPrice || null, bidBond:bidBond || null,
    qualifications:qualifications || null, remarks:remarks || null, detailUrl, documents};
}
async function fetchApcDetail(pid, fallback) {
  const url = ORIGIN + '/En/TendersDetails?PID=' + encodeURIComponent(pid);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:controller.signal});
    if(!r.ok) throw new Error('APC detail returned HTTP '+r.status);
    return parseApcDetail(await r.text(),pid,fallback);
  } finally { clearTimeout(timer); }
}
async function syncAPC() {
  const { getDB, uid } = require('../db');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  let html;
  try {
    const r = await fetch(LIST_URL, { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)' }, signal: controller.signal });
    if (!r.ok) throw new Error('APC returned HTTP ' + r.status);
    html = await r.text();
  } finally { clearTimeout(timer); }
  const rows = parseApcRows(html);
  if (!rows.length) throw new Error('APC page loaded but no recognizable tender rows were found; importer stopped without changing records.');
  const detailResults = await Promise.all(rows.map(async row => {
    try { return {pid:row.id,detail:await fetchApcDetail(row.id,row),error:null}; }
    catch(err) { return {pid:row.id,detail:null,error:(err.message||String(err)).slice(0,200)}; }
  }));
  const detailsByPid = new Map(detailResults.filter(x=>x.detail).map(x=>[x.pid,x.detail]));
  const detailFailures = detailResults.filter(x=>x.error).length;
  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
    VALUES (@rowId,'apc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
    ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,
    tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,
    source_url=excluded.source_url,status=excluded.status,language=excluded.language,details_json=COALESCE(excluded.details_json,tender_opportunities.details_json),updated_at=unixepoch()`);
  const tx = db.transaction((items) => {
    let added = 0, updated = 0;
    for (const n of items) {
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('apc', n.id);
      const detail=detailsByPid.get(n.id)||null;
      const opportunityId=old?old.id:uid('opp_');
      upsert.run({ rowId: opportunityId, externalId: n.id, title: detail?.title||n.title, authority: n.authority, country: n.country, sector: n.sector,
        tenderNumber: n.tenderNumber, summary: n.summary, publishedAt: n.publishedAt, closingAt: n.closingAt, sourceUrl: n.sourceUrl,
        applicationUrl: n.applicationUrl, status: n.status, language: n.language, detailsJson: detail?JSON.stringify(detail):null });
      if(detail){
        db.prepare('DELETE FROM tender_opportunity_public_documents WHERE opportunity_id=?').run(opportunityId);
        const docInsert=db.prepare('INSERT OR IGNORE INTO tender_opportunity_public_documents (id,opportunity_id,label,document_url,availability) VALUES (?,?,?,?,?)');
        detail.documents.forEach(doc=>docInsert.run(uid('oppdoc_'),opportunityId,doc.label,doc.url,doc.availability));
      }
      if (old) updated++; else added++;
    }
    return { added, updated };
  });
  return { ...tx(rows), received: rows.length, normalized: rows.length, detailsReceived:detailsByPid.size, detailFailures, source: 'apc', sourceUrl: LIST_URL };
}
module.exports = { parseApcRows, parseApcDetail, fetchApcDetail, syncAPC, LIST_URL };
