'use strict';
const express = require('express');
const router = express.Router();
const { getDB } = require('../db');
const { SOURCES } = require('../data/tender-sources');

function ensureSources() {
  const db = getDB();
  const insert = db.prepare(`INSERT INTO tender_sources
    (source_key,name_ar,name_en,country_code,market_scope,publisher_type,organization_family,source_url,connector_status,access_mode)
    VALUES (@key,@nameAr,@nameEn,@countryCode,@marketScope,@publisherType,@organizationFamily,@url,@connectorStatus,@accessMode)
    ON CONFLICT(source_key) DO UPDATE SET name_ar=excluded.name_ar,name_en=excluded.name_en,
    country_code=excluded.country_code,market_scope=excluded.market_scope,publisher_type=excluded.publisher_type,
    organization_family=excluded.organization_family,source_url=excluded.source_url,
    connector_status=excluded.connector_status,access_mode=excluded.access_mode,updated_at=unixepoch()`);
  const tx = db.transaction(() => SOURCES.forEach(s => insert.run({
    key:s.key,nameAr:s.nameAr,nameEn:s.nameEn,countryCode:s.countryCode,marketScope:s.marketScope,
    publisherType:s.publisherType,organizationFamily:s.organizationFamily||null,url:s.url,
    connectorStatus:s.connectorStatus,accessMode:s.accessMode
  })));
  tx();
}
router.get('/sources', (req,res) => {
  ensureSources();
  const rows=getDB().prepare(`SELECT source_key AS sourceKey,name_ar AS nameAr,name_en AS nameEn,
    country_code AS countryCode,market_scope AS marketScope,publisher_type AS publisherType,
    organization_family AS organizationFamily,source_url AS url,connector_status AS connectorStatus,
    last_synced_at AS lastSyncedAt,last_sync_status AS lastSyncStatus,last_sync_message AS lastSyncMessage
    FROM tender_sources WHERE enabled=1 ORDER BY country_code,name_en`).all();
  res.json({count:rows.length,sources:rows});
});

router.get('/', (req,res) => {
  ensureSources();
  const db=getDB();
  const where=['t.review_status = ?']; const params=['published'];
  const filters=[['country','country_code'],['market','market_scope'],['publisherType','publisher_type'],['category','category_key'],['status','status']];
  for(const [key,col] of filters){const value=String(req.query[key]||'').trim();if(value){where.push('t.'+col+' = ?');params.push(value);}}
  const source=String(req.query.source||'').trim();if(source){where.push('t.source_key = ?');params.push(source);}
  const q=String(req.query.q||'').trim();
  if(q){where.push('(t.title LIKE ? OR t.tender_number LIKE ? OR t.publisher_name LIKE ? OR t.description LIKE ? OR t.qualification LIKE ?)');const like='%'+q+'%';params.push(like,like,like,like,like);}
  const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
  const offset=Math.max(0,Number(req.query.offset)||0);
  const sql=`SELECT t.id,t.source_key AS sourceKey,s.name_en AS sourceNameEn,s.name_ar AS sourceNameAr,
    t.source_ref AS sourceRef,t.country_code AS countryCode,t.market_scope AS marketScope,
    t.publisher_type AS publisherType,t.organization_family AS organizationFamily,
    t.publisher_name AS publisherName,t.tender_number AS tenderNumber,t.title,t.description,
    t.category_key AS categoryKey,t.tender_type AS tenderType,t.published_at AS publishedAt,
    t.purchase_deadline AS purchaseDeadline,t.closing_at AS closingAt,t.status,t.currency,
    t.estimated_value AS estimatedValue,t.bid_bond AS bidBond,t.document_fee AS documentFee,
    t.qualification,t.official_url AS officialUrl,t.last_verified_at AS lastVerifiedAt,
    (SELECT COUNT(*) FROM public_tender_documents d WHERE d.public_tender_id=t.id) AS documentCount
    FROM public_tenders t JOIN tender_sources s ON s.source_key=t.source_key
    WHERE ${where.join(' AND ')} ORDER BY CASE WHEN t.closing_at IS NULL THEN 1 ELSE 0 END,t.closing_at ASC
    LIMIT ? OFFSET ?`;
  const rows=db.prepare(sql).all(...params,limit,offset);
  const total=db.prepare('SELECT COUNT(*) AS n FROM public_tenders t WHERE '+where.join(' AND ')).get(...params).n;
  res.json({count:rows.length,total,limit,offset,tenders:rows});
});

router.get('/:id', (req,res) => {
  ensureSources();
  const db=getDB();
  const tender=db.prepare(`SELECT t.*,s.name_ar AS source_name_ar,s.name_en AS source_name_en
    FROM public_tenders t JOIN tender_sources s ON s.source_key=t.source_key
    WHERE t.id=? AND t.review_status='published'`).get(req.params.id);
  if(!tender)return res.status(404).json({error:{code:'NOT_FOUND',message:'العطاء غير موجود.'}});
  const documents=db.prepare('SELECT label,document_url AS url,mime_type AS mimeType,availability FROM public_tender_documents WHERE public_tender_id=?').all(tender.id);
  res.json({tender,documents});
});
module.exports=router;
