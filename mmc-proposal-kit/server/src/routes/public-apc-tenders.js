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
  const title = (text.match(/Tender title and number:\s*(.*?)(?=\s*Purchase Date:)/i) || [])[1] || null;
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
    title: title || ('APC Tender ' + pid),
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
    if (cache.error) throw new Error(cache.error);
    return cache.tenders;
  }
  const html = await fetchText(LIST_URL);
  const ids = new Set();
  const linkRe = /(?:TendersDetails\?PID=|TendersDetails%3fPID%3d)(\d+)/gi;
  let match;
  while ((match = linkRe.exec(html))) ids.add(match[1]);
  if (!ids.size) throw new Error('Could not identify public tender detail links on APC listing page');
  const tenders = [];
  for (const id of ids) {
    try {
      const detail = await fetchText(DETAIL_BASE + encodeURIComponent(id));
      tenders.push(extractDetails(detail, id));
    } catch (error) {
      tenders.push({
        id: 'apc-' + id, sourceKey: 'arab-potash-company', source: 'Arab Potash Company (APC)',
        countryCode: 'JO', title: 'APC Tender ' + id, detailUrl: DETAIL_BASE + id,
        documents: [], status: 'unverified', fetchError: error.message
      });
    }
  }
  cache = { at: Date.now(), tenders, error: null };
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
      if (status === 'open' && t.closingDate) {
        const parts = t.closingDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (parts) {
          const close = new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1]), 23, 59, 59);
          if (close < new Date()) return false;
        }
      }
      return true;
    });
    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      source: 'Arab Potash Company (APC)', fetchedAt: new Date(cache.at).toISOString(),
      count: filtered.length, tenders: filtered
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
    res.json({ tender });
  } catch (error) {
    res.status(502).json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'تعذر الوصول إلى مصدر العطاءات.' } });
  }
});

module.exports = router;
