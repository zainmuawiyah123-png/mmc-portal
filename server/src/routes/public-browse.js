'use strict';
// Read-only public browsing endpoints. Deliberately mounted before authenticated portal routers.
// Never return account, bidder, proposal, evaluation, financial-submission, or document-storage data.
const express = require('express');
const { getDB } = require('../db');
const router = express.Router();
const clean = (v, n=120) => String(v == null ? '' : v).trim().slice(0,n);
const ammanToday = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());

router.get('/procurement/tenders', (req,res) => {
  const db=getDB();
  const q=clean(req.query.q,120);
  const rows=db.prepare(`
    SELECT id,name,name_en,reference,authority,closing,country,notes,notes_en,
           technical_weight,financial_weight,technical_threshold,procurement_status,created_at
    FROM tenders
    WHERE procurement_status='published'
      AND EXISTS (SELECT 1 FROM org_verifications ov WHERE ov.user_id=tenders.user_id AND ov.status='verified' AND (ov.expires_at IS NULL OR ov.expires_at>unixepoch()))
      AND (closing IS NULL OR closing='' OR substr(closing,1,10)>=?)
      AND (?='' OR name LIKE ? OR name_en LIKE ? OR reference LIKE ? OR authority LIKE ?)
    ORDER BY CASE WHEN closing IS NULL OR closing='' THEN 1 ELSE 0 END, closing ASC, created_at DESC
    LIMIT 200
  `).all(ammanToday(),q,'%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%');
  const ids=rows.map(x=>x.id);
  const reqs=new Map();
  if(ids.length){
    const placeholders=ids.map(()=>'?').join(',');
    for(const r of db.prepare(`SELECT id,tender_id,title,title_en,description,description_en,weight,mandatory,sort_order FROM tender_requirements WHERE tender_id IN (${placeholders}) ORDER BY sort_order`).all(...ids)){
      if(!reqs.has(r.tender_id)) reqs.set(r.tender_id,[]);
      reqs.get(r.tender_id).push({id:r.id,title:r.title,titleEn:r.title_en||null,description:r.description||null,descriptionEn:r.description_en||null,weight:r.weight,mandatory:!!r.mandatory});
    }
  }
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({tenders:rows.map(t=>({
    id:t.id,name:t.name,nameEn:t.name_en||null,reference:t.reference,authority:t.authority||null,
    closing:t.closing||null,country:t.country||'JO',notes:t.notes||null,notesEn:t.notes_en||null,
    technicalWeight:t.technical_weight,financialWeight:t.financial_weight,
    technicalThreshold:t.technical_threshold,requirements:reqs.get(t.id)||[],
    expired:false,publicView:true
  })),count:rows.length});
});


router.get('/procurement/tenders/:id', (req,res) => {
  const db=getDB();
  const t=db.prepare(`
    SELECT id,name,name_en,reference,authority,closing,country,notes,notes_en,
           technical_weight,financial_weight,technical_threshold
    FROM tenders
    WHERE id=? AND procurement_status='published'
      AND EXISTS (SELECT 1 FROM org_verifications ov WHERE ov.user_id=tenders.user_id AND ov.status='verified' AND (ov.expires_at IS NULL OR ov.expires_at>unixepoch()))
      AND (closing IS NULL OR closing='' OR substr(closing,1,10)>=?)
  `).get(req.params.id,ammanToday());
  if(!t) return res.status(404).json({error:{code:'NOT_FOUND',message:'العطاء غير متاح للعرض العام.'}});
  const requirements=db.prepare(`
    SELECT id,title,title_en,description,description_en,weight,mandatory,sort_order
    FROM tender_requirements WHERE tender_id=? ORDER BY sort_order
  `).all(t.id);
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({tender:{
    id:t.id,name:t.name,nameEn:t.name_en||null,reference:t.reference,
    authority:t.authority||null,closing:t.closing||null,country:t.country||'JO',
    notes:t.notes||null,notesEn:t.notes_en||null,
    technicalWeight:t.technical_weight,financialWeight:t.financial_weight,
    technicalThreshold:t.technical_threshold,
    requirements:requirements.map(x=>({id:x.id,title:x.title,titleEn:x.title_en||null,
      description:x.description||null,descriptionEn:x.description_en||null,
      weight:x.weight,mandatory:!!x.mandatory}))
  }});
});

router.get('/contractor/opportunities', (req,res) => {
  const db=getDB();
  const q=clean(req.query.q,120), country=clean(req.query.country,3).toUpperCase();
  const rows=db.prepare(`
    SELECT id,title,authority,country,sector,tender_number,summary,published_at,closing_at,
           source_url,application_url,status,language,source_key,imported_at
    FROM tender_opportunities
    WHERE status IN ('open','closed')
      AND (?='' OR title LIKE ? OR authority LIKE ? OR tender_number LIKE ? OR summary LIKE ?)
      AND (?='' OR country=?)
    ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, COALESCE(closing_at,'9999-12-31') ASC, imported_at DESC
    LIMIT 250
  `).all(q,'%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%',country,country);
  const today=ammanToday();
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({opportunities:rows.map(r=>({
    id:r.id,title:r.title,authority:r.authority,country:r.country,sector:r.sector,
    tenderNumber:r.tender_number,summary:r.summary,publishedAt:r.published_at,
    closingAt:r.closing_at,sourceUrl:r.source_url,applicationUrl:r.application_url,
    status:(r.closing_at && String(r.closing_at).slice(0,10)<today)?'closed':r.status,
    language:r.language,sourceKey:r.source_key,importedAt:r.imported_at
  })),count:rows.length});
});

router.get('/consulting/requests', (req,res) => {
  const db=getDB(), now=Math.floor(Date.now()/1000);
  const q=clean(req.query.q,120), discipline=clean(req.query.discipline,100), country=clean(req.query.country,2).toUpperCase();
  const rows=db.prepare(`
    SELECT id,reference,title,discipline,country,location,description,scope_json,currency,
           budget_min,budget_max,closing_at,created_at
    FROM consulting_service_requests csr
    INNER JOIN consulting_requester_entities cre ON cre.id=csr.requester_entity_id AND cre.verification_status='verified'
    WHERE csr.status='open' AND (csr.closing_at IS NULL OR csr.closing_at>?)
      AND (?='' OR title LIKE ? OR reference LIKE ? OR description LIKE ? OR discipline LIKE ?)
      AND (?='' OR discipline=?) AND (?='' OR country=?)
    ORDER BY created_at DESC LIMIT 200
  `).all(now,q,'%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%',discipline,discipline,country,country);
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({requests:rows.map(r=>({
    id:r.id,reference:r.reference,title:r.title,discipline:r.discipline,country:r.country,
    location:r.location,description:r.description,scope:(()=>{try{return JSON.parse(r.scope_json||'[]')}catch(_){return []}})(),
    currency:r.currency,budget_min:r.budget_min,budget_max:r.budget_max,
    closing_at:r.closing_at,created_at:r.created_at,publicView:true
  })),count:rows.length});
});

module.exports = router;
