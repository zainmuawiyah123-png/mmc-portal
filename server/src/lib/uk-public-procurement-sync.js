'use strict';
/**
 * Read-only UK public procurement feeds using official OCDS endpoints.
 * Imports notices only; supplier login, document purchase and bid submission
 * remain on the issuing authority's portal.
 */
const { getDB, uid } = require('../db');

const FTS_URL = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const PCS_URL = 'https://api.publiccontractsscotland.gov.uk/v1/Notices';
const clean = (v, n=3000) => String(v == null ? '' : v).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const isoDate = v => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
function unpackPackages(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload.flatMap(unpackPackages);
  if (Array.isArray(payload.releases)) return payload.releases;
  if (Array.isArray(payload.packages)) return payload.packages.flatMap(unpackPackages);
  if (Array.isArray(payload.records)) return payload.records.flatMap(x => x && x.releases ? x.releases : []);
  if (Array.isArray(payload.results)) return payload.results.flatMap(unpackPackages);
  if (payload.package && Array.isArray(payload.package.releases)) return payload.package.releases;
  return [];
}
function normalizeOcdsRelease(release, sourceKey) {
  if (!release || typeof release !== 'object') return null;
  const tender = release.tender || {};
  const buyer = release.buyer || {};
  const title = clean(tender.title || release.title, 300);
  const externalId = clean(release.ocid || release.id, 160);
  if (!title || !externalId || !tender || !Object.keys(tender).length) return null;
  const end = isoDate(tender.tenderPeriod && tender.tenderPeriod.endDate);
  const today = new Date().toISOString().slice(0,10);
  const closingAt = end ? end.slice(0,10) : null;
  const status = closingAt && closingAt < today ? 'closed' : 'open';
  const cpv = Array.isArray(tender.items) ? tender.items.map(x => x && x.classification && x.classification.description).filter(Boolean).slice(0,4).join(' · ') : '';
  const categories = Array.isArray(tender.items) ? tender.items.map(x => x && x.classification && x.classification.id).filter(Boolean).slice(0,4).join(', ') : '';
  let sourceUrl = sourceKey === 'findatender'
    ? 'https://www.find-tender.service.gov.uk/'
    : 'https://www.publiccontractsscotland.gov.uk/';
  const links = Array.isArray(tender.documents) ? tender.documents : [];
  const publicLink = links.find(x => x && /^https:\/\//i.test(x.url || '') && /find-tender\.service\.gov\.uk|publiccontractsscotland\.gov\.uk/i.test(x.url));
  if (publicLink) sourceUrl = publicLink.url;
  else if (sourceKey === 'findatender' && /^\d{4,}-\d{4,}$/.test(String(release.id || ''))) {
    sourceUrl = 'https://www.find-tender.service.gov.uk/Notice/' + encodeURIComponent(release.id);
  }
  const description = clean(tender.description || release.description, 2400);
  const summary = [clean(tender.status,80), clean(tender.procurementMethod,100), categories, cpv, description].filter(Boolean).join(' · ').slice(0,3000);
  const reference = clean(tender.id || release.id || externalId,120);
  return {
    id: externalId, title, authority: clean(buyer.name || 'UK public contracting authority',200),
    country:'GB', sector: cpv || null, tenderNumber:reference,
    summary:summary || null, publishedAt:isoDate(release.date || release.publishedDate),
    closingAt:end || null, sourceUrl, applicationUrl:null, status, language:'en'
  };
}
function saveRows(sourceKey, notices) {
  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
    VALUES (@rowId,@sourceKey,@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
    ON CONFLICT(source_key,external_id) DO UPDATE SET
    title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,
    tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
    closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,
    language=excluded.language,updated_at=unixepoch()`);
  const tx = db.transaction(items => {
    let added=0, updated=0;
    for (const item of items) {
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get(sourceKey,item.id);
      upsert.run({rowId:old ? old.id : uid('opp_'),sourceKey,externalId:item.id,title:item.title,authority:item.authority,country:item.country,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status,language:item.language});
      if (old) updated++; else added++;
    }
    return {added,updated};
  });
  return tx(notices);
}
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {headers:{Accept:'application/json','User-Agent':'MMC-TenderWise/1.0 (public procurement data reader)'},signal:controller.signal});
    if (!response.ok) throw new Error('UK public feed returned HTTP '+response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function syncFindATender({days=14,maxPages=10}={}) {
  const now = new Date(), from = new Date(now.getTime()-Math.max(1,days)*86400000);
  const stamp = d => d.toISOString().slice(0,19);
  let url = new URL(FTS_URL);
  url.searchParams.set('updatedFrom',stamp(from));
  url.searchParams.set('updatedTo',stamp(now));
  url.searchParams.set('limit','100');
  const releases = [], visited = new Set();
  for (let page=0; page<Math.min(20,Math.max(1,maxPages)) && url; page++) {
    if (visited.has(url.toString())) throw new Error('Find a Tender pagination loop detected');
    visited.add(url.toString());
    const payload = await getJson(url);
    releases.push(...unpackPackages(payload));
    const next = payload && payload.links && payload.links.next;
    if (!next) { url=null; break; }
    const nextUrl = new URL(next,FTS_URL);
    if (nextUrl.origin !== 'https://www.find-tender.service.gov.uk') throw new Error('Find a Tender returned an unexpected pagination host');
    url=nextUrl;
  }
  const normalized = releases.map(x=>normalizeOcdsRelease(x,'findatender')).filter(Boolean);
  const counts = saveRows('findatender',normalized);
  return {...counts,received:releases.length,normalized:normalized.length,source:'findatender',pages:visited.size};
}
async function syncPublicContractsScotland({months=2}={}) {
  const releases = [];
  const now = new Date();
  for (let i=0;i<Math.min(6,Math.max(1,months));i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));
    const dateFrom = String(d.getUTCMonth()+1).padStart(2,'0')+'-'+d.getUTCFullYear();
    const url = new URL(PCS_URL);
    url.searchParams.set('dateFrom',dateFrom);
    url.searchParams.set('noticeType','2');
    url.searchParams.set('outputType','0');
    const payload = await getJson(url);
    releases.push(...unpackPackages(payload));
  }
  const normalized = releases.map(x=>normalizeOcdsRelease(x,'pcs')).filter(Boolean);
  const unique = [...new Map(normalized.map(x=>[x.id,x])).values()];
  const counts = saveRows('pcs',unique);
  return {...counts,received:releases.length,normalized:unique.length,source:'pcs',months:Math.min(6,Math.max(1,months))};
}
module.exports = { normalizeOcdsRelease, unpackPackages, syncFindATender, syncPublicContractsScotland };
