'use strict';

/**
 * Public APC tender feed.
 * Fetches only APC's publicly accessible tender listing and detail pages.
 * No supplier login, CAPTCHA, or restricted portal access is attempted.
 */
const express = require('express');
const router = express.Router();

const LIST_URL = 'https://www.arabpotash.com/EN/Modules/Tenders';
const DETAIL_BASE = 'https://www.arabpotash.com/En/TendersDetails?PID=';
const HOST = 'www.arabpotash.com';
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, tenders: [], error: null };

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function plainText(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')).trim();
}

function field(text, label, nextLabels) {
  const next = nextLabels.join('|');
  const re = new RegExp(label + '\\s*:?\\s*([\\s\\S]*?)(?=\\s*(?:' + next + ')\\s*:?|$)', 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function extractDetails(html, pid) {
  const text = plainText(html);
  const title = ((text.match(/Tender title and number:\s*(.*?)(?=\s*Purchase Date:)/i) || [])[1] || '').trim();
  if (!title) throw new Error('APC detail page did not contain a verifiable tender title and number');
  const purchaseDate = field(text, 'Purchase Date', ['Closing date']);
  const closingDate = field(text, 'Closing date', ['Copy Price']);
  const copyPrice = field(text, 'Copy Price', ['Bid Bond Value']);
  const bidBond = field(text, 'Bid Bond Value', ['Vendor Qualifications']);
  const qualifications = field(text, 'Vendor Qualifications', ['Remarks', 'Announcement', 'Tender Documents']);
  const remarks = field(text, 'Remarks', ['Announcement', 'Tender Documents']);
  const documents = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const label = plainText(m[2]);
    if (!/announcement|document|وثائق|اعلان|إعلان/i.test(label)) continue;
    let url;
    try { url = new URL(decodeHtml(m[1]), DETAIL_BASE + pid); } catch (_) { continue; }
    if (url.protocol !== 'https:' || url.hostname !== HOST) continue;
    documents.push({ label, url: url.toString(), availability: 'public-link' });
  }
  return {
    id: 'apc-' + pid,
    sourceKey: 'arab-potash-company',
    source: 'Arab Potash Company (APC)',
    countryCode: 'JO',
    marketScope: 'private-sector',
    publisherType: 'private-company',
    tenderNumber: title ? (title.match(/(?:IFB|Tender|Prequalification)[^:]*\s*(?:No\.?|Number)?\s*:?\s*([\w/-]+)/i) || [])[1] || null : null,
    title,
    purchaseDate,
    closingDate,
    copyPrice,
    bidBond,
    qualifications,
    remarks,
    detailUrl: DETAIL_BASE + encodeURIComponent(pid),
    documents,
    fetchedAt: new Date().toISOString(),
    status: 'unverified'
  };
}



function hasValidClosingDate(value) {
  const text = String(value || '').trim();
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  let day, month, year;
  if (m) { day = Number(m[1]); month = Number(m[2]); year = Number(m[3]); }
  else {
    m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toIsoDate(value) {
  const text = String(value || '').trim();
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  let day, month, year;
  if (m) { day = Number(m[1]); month = Number(m[2]); year = Number(m[3]); }
  else {
    m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function persistTenders(tenders, failures = []) {
  const db = require('../db').getDB();
  db.prepare(`INSERT INTO tender_sources
    (source_key,name_ar,name_en,country_code,market_scope,publisher_type,organization_family,source_url,connector_status,access_mode,last_synced_at,last_sync_status,last_sync_message)
    VALUES ('arab-potash-company','شركة البوتاس العربية','Arab Potash Company (APC)','JO','private-sector','private-company','jordanian-industrial-companies',?,?,'public-listing',unixepoch(),?,?)
    ON CONFLICT(source_key) DO UPDATE SET connector_status=excluded.connector_status,last_synced_at=unixepoch(),last_sync_status=excluded.last_sync_status,last_sync_message=excluded.last_sync_message,updated_at=unixepoch()`)
    .run(LIST_URL,failures.length ? 'degraded' : 'active',failures.length ? 'partial' : 'success','Fetched '+tenders.length+' tender records; '+failures.length+' detail pages failed');
  const upsert = db.prepare(`INSERT INTO public_tenders
    (id,source_key,source_ref,country_code,market_scope,publisher_type,organization_family,publisher_name,
     tender_number,title,purchase_deadline,closing_at,status,bid_bond,document_fee,qualification,official_url,
     last_verified_at,review_status,raw_metadata)
    VALUES (@id,'arab-potash-company',@sourceRef,'JO','private-sector','private-company',
     'jordanian-industrial-companies','شركة البوتاس العربية',@tenderNumber,@title,@purchaseDateIso,@closingDateIso,
     @status,@bidBond,@copyPrice,@qualifications,@detailUrl,unixepoch(),@reviewStatus,@rawMetadata)
    ON CONFLICT(source_key,source_ref) DO UPDATE SET title=excluded.title,tender_number=excluded.tender_number,
     purchase_deadline=excluded.purchase_deadline,closing_at=excluded.closing_at,status=excluded.status,
     bid_bond=excluded.bid_bond,document_fee=excluded.document_fee,qualification=excluded.qualification,
     official_url=excluded.official_url,last_verified_at=unixepoch(),fetched_at=unixepoch(),
     review_status=excluded.review_status,raw_metadata=excluded.raw_metadata,updated_at=unixepoch()`);
  const doc = db.prepare(`INSERT INTO public_tender_documents
    (id,public_tender_id,label,document_url,availability)
    VALUES (@id,@tenderId,@label,@url,'source-link')
    ON CONFLICT(public_tender_id,document_url) DO UPDATE SET label=excluded.label`);
  db.transaction(()=>tenders.forEach(t=>{
    const reviewStatus = t.title && hasValidClosingDate(t.closingDate) && /^https:\/\/www\.arabpotash\.com\//i.test(t.detailUrl) ? 'published' : 'needs-review';
    const closingDateIso = toIsoDate(t.closingDate);
    const purchaseDateIso = toIsoDate(t.purchaseDate);
    const isClosed = Boolean(closingDateIso && closingDateIso < new Date().toISOString().slice(0,10));
    const status = !closingDateIso ? 'unknown' : (isClosed ? 'closed' : 'open');
    upsert.run({...t,reviewStatus,purchaseDateIso,closingDateIso,status,sourceRef:t.id.replace('apc-',''),rawMetadata:JSON.stringify(t)});
    for(const d of (t.documents||[])) doc.run({id:'apc-doc-'+require('crypto').createHash('sha1').update(t.id+d.url).digest('hex'),tenderId:t.id,label:d.label||'Tender document',url:d.url});
  }))();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MMC-Tender-Directory/1.0 (public tender index)', accept: 'text/html' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('APC returned HTTP ' + response.status);
  return response.text();
}

async function loadTenders(force) {
  if (!force && cache.at && Date.now() - cache.at < CACHE_MS) {
    if (cache.error && !cache.tenders.length) throw new Error(cache.error);
    return cache.tenders;
  }
  const html = await fetchText(LIST_URL);
  const ids = new Set();
  const linkRe = /(?:TendersDetails\?PID=|TendersDetails%3fPID%3d)(\d+)/gi;
  let match;
  while ((match = linkRe.exec(html))) ids.add(match[1]);
  if (!ids.size) throw new Error('Could not identify public tender detail links on APC listing page');
  const tenders = [];
  const failures = [];
  for (const id of ids) {
    try {
      const detail = await fetchText(DETAIL_BASE + encodeURIComponent(id));
      tenders.push(extractDetails(detail, id));
    } catch (error) {
      failures.push({ id, message: error.message });
    }
  }
  if (!tenders.length) throw new Error('APC listing found ' + ids.size + ' tender links but no detail page could be read');
  persistTenders(tenders, failures);
  cache = { at: Date.now(), tenders, error: failures.length ? (failures.length + ' detail pages could not be fetched') : null };
  return tenders;
}

router.get('/', async (req, res) => {
  try {
    const tenders = await loadTenders(false);
    const q = String(req.query.q || '').trim().toLocaleLowerCase();
    const status = String(req.query.status || '').trim().toLowerCase();
    const filtered = tenders.filter((t) => {
      const haystack = [t.title, t.tenderNumber, t.qualifications, t.remarks].filter(Boolean).join(' ').toLocaleLowerCase();
      if (q && !haystack.includes(q)) return false;
      const closingDateIso = toIsoDate(t.closingDate);
      const today = new Date().toISOString().slice(0, 10);
      if (status === 'open' && (!closingDateIso || closingDateIso < today)) return false;
      if (status === 'closed' && (!closingDateIso || closingDateIso >= today)) return false;
      if (status === 'unknown' && closingDateIso) return false;
      return true;
    });
    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      source: 'Arab Potash Company (APC)', fetchedAt: new Date(cache.at).toISOString(),
      count: filtered.length, scanned: tenders.length, partial: Boolean(cache.error), warning: cache.error,
      tenders: filtered
    });
  } catch (error) {
    res.status(502).json({
      error: { code: 'SOURCE_UNAVAILABLE', message: 'تعذر تحديث عطاءات شركة البوتاس حالياً.' },
      source: 'Arab Potash Company (APC)', detail: error.message
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const tenders = await loadTenders(false);
    const tender = tenders.find((item) => item.id === req.params.id);
    if (!tender) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'العطاء غير موجود في المصدر العام.' } });
    const db = require('../db').getDB();
    const documents = db.prepare('SELECT label,document_url AS url,mime_type AS mimeType,availability FROM public_tender_documents WHERE public_tender_id=?').all(tender.id);
    res.json({ tender, documents });
  } catch (error) {
    res.status(502).json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'تعذر الوصول إلى مصدر العطاءات.' } });
  }
});

module.exports = router;
