'use strict';
/**
 * Curated, human-verified snapshot of Greater Amman Municipality tenders.
 * This is intentionally an import/upsert, not an unattended scraper: GAM uses
 * stateful notice pages and requires bidders to obtain the official tender copy.
 */
const fs = require('fs');
const path = require('path');
const { getDB, uid } = require('../db');
const DATA_PATH = path.join(__dirname, '..', 'data', 'gamtenders-current.json');

function ammanNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = name => parts.find(part => part.type === name)?.value || '';
  return value('year') + '-' + value('month') + '-' + value('day') + 'T' + value('hour') + ':' + value('minute');
}
function normalizeGAMNotice(row, source, nowLocal = ammanNow()) {
  if (!row || !row.externalId || !row.title || !row.closingAt) return null;
  const sourceUrl = new URL(source.sourceUrl);
  if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'www.gamtenders.gov.jo') return null;
  const closingAt = String(row.closingAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closingAt)) return null;
  const closingTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(row.closingTime || '') ? row.closingTime : '23:59';
  const status = closingAt + 'T' + closingTime < nowLocal ? 'closed' : 'open';
  return {
    id: String(row.externalId),
    title: String(row.title).trim().slice(0, 300),
    authority: source.authority,
    country: 'JO',
    sector: String(row.sector || '').trim().slice(0, 100) || null,
    tenderNumber: String(row.tenderNumber || row.externalId).slice(0, 120),
    summary: String(row.summary || '').trim().slice(0, 3000),
    publishedAt: row.publishedAt || null,
    closingAt: closingAt + 'T' + closingTime + ':00+03:00',
    sourceUrl: source.sourceUrl,
    applicationUrl: null,
    status,
    language: row.language === 'en' ? 'en' : 'ar'
  };
}
function syncGAMCurated({ nowLocal = ammanNow() } = {}) {
  const source = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const rows = (Array.isArray(source.tenders) ? source.tenders : [])
    .map(row => normalizeGAMNotice(row, source, nowLocal)).filter(Boolean);
  if (!rows.length) throw new Error('No verified GAM notices were eligible for import; existing records were left unchanged.');
  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
    VALUES (@rowId,'amman',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
    ON CONFLICT(source_key,external_id) DO UPDATE SET
      title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,
      tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
      closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,
      status=excluded.status,language=excluded.language,updated_at=unixepoch()`);
  const tx = db.transaction(items => {
    let added = 0, updated = 0;
    for (const item of items) {
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('amman', item.id);
      upsert.run({ rowId: old ? old.id : uid('opp_'), externalId: item.id, title: item.title, authority: item.authority,
        country: item.country, sector: item.sector, tenderNumber: item.tenderNumber, summary: item.summary,
        publishedAt: item.publishedAt, closingAt: item.closingAt, sourceUrl: item.sourceUrl,
        applicationUrl: item.applicationUrl, status: item.status, language: item.language });
      if (old) updated++; else added++;
    }
    return { added, updated };
  });
  return { ...tx(rows), received: source.tenders.length, normalized: rows.length, source: 'amman',
    sourceUrl: source.sourceUrl, verifiedAt: source.verifiedAt, snapshotOnly: true };
}
module.exports = { normalizeGAMNotice, syncGAMCurated, DATA_PATH };
