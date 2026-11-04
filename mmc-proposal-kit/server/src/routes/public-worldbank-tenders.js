'use strict';

/**
 * World Bank public procurement notices connector.
 * Uses the World Bank's public Search API; no credentials or supplier login.
 * Source: https://search.worldbank.org/api/v2/procnotices
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const API_URL = 'https://search.worldbank.org/api/v2/procnotices';
const SOURCE_URL = 'https://projects.worldbank.org/en/projects-operations/procurement';
const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, items: [], warning: null };

function first(obj, keys) {
  for (const key of keys) {
    const value = obj && obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

function asText(value) {
  if (value && typeof value === 'object') return String(value.value || value.name || '');
  return value == null ? '' : String(value).trim();
}

function asDate(value) {
  const raw = asText(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const d = new Date(Date.UTC(+match[1], +match[2]-1, +match[3]));
    if (d.getUTCFullYear() === +match[1] && d.getUTCMonth() === +match[2]-1 && d.getUTCDate() === +match[3]) return match[0];
    return null;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}

function normalizeCountry(value) {
  const c = asText(value).toLowerCase();
  if (c.includes('jordan')) return 'JO';
  if (c.includes('saudi')) return 'SA';
  if (c.includes('united arab emirates') || c === 'uae') return 'AE';
  return null;
}

function normalizeNotice(raw) {
  const id = asText(first(raw, ['id','notice_id','noticeid','noticeId','notice_number']));
  const title = asText(first(raw, ['bid_description','notice_title','title','description','bidDescription']));
  const country = asText(first(raw, ['project_ctry_name','country_name','country','projectCountry']));
  const noticeType = asText(first(raw, ['notice_type','noticeType','type']));
  const deadline = asDate(first(raw, ['submission_deadline_date','deadline_date','submission_deadline','deadline']));
  const published = asDate(first(raw, ['noticedate','notice_date','publication_date','published_date']));
  if (!id || !title) return null;
  const officialUrl = 'https://projects.worldbank.org/en/projects-operations/procurement-detail/' + encodeURIComponent(id);
  return {
    id: 'wb-' + id,
    sourceKey: 'world-bank-procurement',
    sourceRef: id,
    countryCode: normalizeCountry(country),
    marketScope: 'development-financed',
    publisherType: 'multilateral-bank',
    organizationFamily: 'development-banks',
    publisherName: 'World Bank Group',
    tenderNumber: id,
    title,
    description: [asText(first(raw,['project_name','projectname','project_title'])), noticeType, country].filter(Boolean).join(' — ') || null,
    noticeType: noticeType || null,
    publishedAt: published,
    closingAt: deadline,
    status: /award/i.test(noticeType) ? 'awarded' : (deadline ? 'open' : 'unknown'),
    officialUrl,
    raw
  };
}

function extractRows(payload) {
  const candidates = [
    payload && payload.procnotices && payload.procnotices.notice,
    payload && payload.procnotices,
    payload && payload.notices,
    payload && payload.results,
    payload && payload.data
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && Array.isArray(candidate.notice)) return candidate.notice;
    if (candidate && typeof candidate === 'object') return Object.values(candidate).filter(x => x && typeof x === 'object');
  }
  return [];
}

async function fetchNotices() {
  const url = API_URL + '?format=json&rows=100&os=0&srt=noticedate%20desc,id%20asc';
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'MMC-Tender-Directory/1.0' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('World Bank API returned HTTP ' + response.status);
  const payload = await response.json();
  const rows = extractRows(payload);
  if (!rows.length) throw new Error('World Bank API response did not contain recognizable notice records');
  return rows.map(normalizeNotice).filter(Boolean);
}

function persist(items) {
  const db = require('../db').getDB();
  db.prepare(`INSERT INTO tender_sources
    (source_key,name_ar,name_en,country_code,market_scope,publisher_type,organization_family,source_url,connector_status,access_mode,last_synced_at,last_sync_status,last_sync_message)
    VALUES ('world-bank-procurement','البنك الدولي — فرص المشتريات','World Bank Procurement',NULL,'development-financed','multilateral-bank','development-banks',?,'active','public API — CC BY 4.0',unixepoch(),'success',?)
    ON CONFLICT(source_key) DO UPDATE SET connector_status='active',last_synced_at=unixepoch(),last_sync_status='success',last_sync_message=excluded.last_sync_message,updated_at=unixepoch()`)
    .run(SOURCE_URL, 'Fetched ' + items.length + ' public notices from World Bank API');

  const upsert = db.prepare(`INSERT INTO public_tenders
    (id,source_key,source_ref,country_code,market_scope,publisher_type,organization_family,publisher_name,tender_number,title,description,published_at,closing_at,status,official_url,last_verified_at,review_status,raw_metadata)
    VALUES (@id,'world-bank-procurement',@sourceRef,@countryCode,'development-financed','multilateral-bank','development-banks','World Bank Group',@tenderNumber,@title,@description,@publishedAt,@closingAt,@status,@officialUrl,unixepoch(),'published',@rawMetadata)
    ON CONFLICT(source_key,source_ref) DO UPDATE SET country_code=excluded.country_code,title=excluded.title,description=excluded.description,published_at=excluded.published_at,closing_at=excluded.closing_at,status=excluded.status,official_url=excluded.official_url,last_verified_at=unixepoch(),fetched_at=unixepoch(),review_status='published',raw_metadata=excluded.raw_metadata,updated_at=unixepoch()`);
  const tx = db.transaction(() => items.forEach(item => upsert.run({
    ...item, rawMetadata: JSON.stringify(item.raw)
  })));
  tx();
}

async function load(force) {
  if (!force && cache.at && Date.now()-cache.at < CACHE_MS) return cache;
  const items = await fetchNotices();
  if (!items.length) throw new Error('No valid World Bank notices were returned');
  persist(items);
  cache = { at: Date.now(), items, warning: null };
  return cache;
}

router.get('/', async (req,res) => {
  try {
    const data = await load(String(req.query.refresh || '') === '1');
    const q = String(req.query.q || '').trim().toLocaleLowerCase();
    const country = String(req.query.country || '').trim().toUpperCase();
    const items = data.items.filter(item =>
      (!q || [item.title,item.description,item.tenderNumber].join(' ').toLocaleLowerCase().includes(q)) &&
      (!country || item.countryCode === country)
    );
    res.set('Cache-Control','no-store');
    res.json({ source:'World Bank Procurement', fetchedAt:new Date(data.at).toISOString(), count:items.length, scanned:data.items.length, tenders:items });
  } catch (error) {
    res.status(502).json({ error:{code:'SOURCE_UNAVAILABLE',message:'تعذر تحديث إشعارات البنك الدولي حالياً.'}, detail:error.message });
  }
});

module.exports = router;
