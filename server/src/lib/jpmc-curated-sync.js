'use strict';
/**
 * Curated, human-verified public JPMC notice snapshot. The public image is an
 * announcement only; full conditions require JPMC eligibility review and payment.
 */
const fs = require('fs');
const path = require('path');
const { getDB, uid } = require('../db');
const { isAllowedPublicDocumentUrl } = require('./public-tender-documents');
const DATA_PATH = path.join(__dirname, '..', 'data', 'jpmc-current.json');
function normalizeNotice(row, source, now = Date.now()) {
  if (!row || !row.externalId || !row.title || !row.closingAt) return null;
  const sourceUrl = new URL(row.sourceUrl);
  if (!isAllowedPublicDocumentUrl('jpmc', sourceUrl.toString())) return null;
  const deadline = Date.parse(row.closingAt);
  if (!Number.isFinite(deadline)) return null;
  const documents = (Array.isArray(row.documents) ? row.documents : []).filter(doc => doc &&
    typeof doc.label === 'string' && isAllowedPublicDocumentUrl('jpmc', doc.url))
    .map(doc => ({ label: doc.label.slice(0, 240), url: doc.url, availability: 'public-source-link' }));
  return { ...row, id: row.externalId, sourceUrl: sourceUrl.toString(), documents, status: deadline <= now ? 'closed' : 'open', country: 'JO', language: 'ar' };
}
function syncJPMCCurated({ now = Date.now() } = {}) {
  const source = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const rows = (Array.isArray(source.tenders) ? source.tenders : []).map(row => normalizeNotice(row, source, now)).filter(Boolean);
  if (!rows.length) throw new Error('No verified JPMC notices were eligible for import; existing records were left unchanged.');
  const db = getDB();
  const upsert = db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
    VALUES (@rowId,'jpmc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
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
      const old = db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jpmc', row.id);
      upsert.run({ rowId: old ? old.id : uid('opp_'), externalId: row.id, title: row.title, authority: row.authority,
        country: row.country, sector: row.sector, tenderNumber: row.tenderNumber, summary: row.summary,
        publishedAt: row.publishedAt, closingAt: row.closingAt, sourceUrl: row.sourceUrl,
        applicationUrl: row.applicationUrl || null, status: row.status, language: row.language, detailsJson: JSON.stringify(row.details || {}) });
      const opportunityId = old ? old.id : db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jpmc', row.id).id;
      if (old) updated++; else added++;
      for (const doc of row.documents) {
        docUpsert.run({ id: uid('oppdoc_'), opportunityId, label: doc.label, documentUrl: doc.url, availability: doc.availability });
        documentsFound++;
      }
    }
    return { added, updated, documentsFound };
  });
  return { ...tx(rows), received: rows.length, normalized: rows.length, source: 'jpmc', sourceUrl: source.sourceUrl,
    verifiedAt: source.verifiedAt, snapshotOnly: true };
}
module.exports = { DATA_PATH, normalizeNotice, syncJPMCCurated };
