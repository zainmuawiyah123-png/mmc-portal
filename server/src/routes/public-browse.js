'use strict';
// Read-only public browsing endpoints. Deliberately mounted before authenticated portal routers.
// Never return account, bidder, proposal, evaluation, financial-submission, or document-storage data.
const express = require('express');
const { getDB } = require('../db');
const router = express.Router();
const clean = (v, n=120) => String(v == null ? '' : v).trim().slice(0,n);
const { isAllowedPublicDocumentUrl, downloadPublicDocument, safeDocumentFilename } = require('../lib/public-tender-documents');
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
  const status=clean(req.query.status,20), source=clean(req.query.source,80), sector=clean(req.query.sector,80);
  const clauses=["status IN ('open','closed')"], values=[];
  const today=ammanToday();
  if(status==='open'){clauses.push("(closing_at IS NULL OR substr(closing_at,1,10)>=?)");values.push(today);}
  else if(status==='closed'){clauses.push("(closing_at IS NOT NULL AND substr(closing_at,1,10)<?)");values.push(today);}
  if(country){clauses.push('country=?');values.push(country);}
  if(source){clauses.push('source_key=?');values.push(source);}
  if(sector){clauses.push('sector=?');values.push(sector);}
  if(q){clauses.push('(title LIKE ? OR authority LIKE ? OR tender_number LIKE ? OR summary LIKE ?)');const like='%'+q+'%';values.push(like,like,like,like);}
  const where=clauses.join(' AND ');
  const rows=db.prepare(`
    SELECT id,title,authority,country,sector,tender_number,summary,published_at,closing_at,
           source_url,application_url,status,language,source_key,imported_at
    FROM tender_opportunities WHERE ${where}
    ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, COALESCE(closing_at,'9999-12-31') ASC, imported_at DESC
    LIMIT 2000
  `).all(...values);
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.json({opportunities:rows.map(r=>({
    id:r.id,title:r.title,authority:r.authority,country:r.country,sector:r.sector,
    tenderNumber:r.tender_number,summary:r.summary,publishedAt:r.published_at,
    closingAt:r.closing_at,sourceUrl:r.source_url,applicationUrl:r.application_url,
    status:r.closing_at?(String(r.closing_at).slice(0,10)<today?'closed':'open'):r.status,
    language:r.language,sourceKey:r.source_key,importedAt:r.imported_at
  })),count:rows.length});
});

router.get('/consulting/requests', (req,res) => {
  const db=getDB(), now=Math.floor(Date.now()/1000);
  const q=clean(req.query.q,120), discipline=clean(req.query.discipline,100), country=clean(req.query.country,2).toUpperCase();
  const rows=db.prepare(`
    SELECT csr.id,csr.reference,csr.title,csr.discipline,csr.country,csr.location,csr.description,csr.scope_json,csr.currency,
           csr.budget_min,csr.budget_max,csr.closing_at,csr.created_at
    FROM consulting_service_requests csr
    INNER JOIN consulting_requester_entities cre ON cre.id=csr.requester_entity_id AND cre.verification_status='verified'
    WHERE csr.status='open' AND (csr.closing_at IS NULL OR csr.closing_at>?)
      AND (?='' OR csr.title LIKE ? OR csr.reference LIKE ? OR csr.description LIKE ? OR csr.discipline LIKE ?)
      AND (?='' OR csr.discipline=?) AND (?='' OR csr.country=?)
    ORDER BY csr.created_at DESC LIMIT 200
  `).all(now,q,'%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%',discipline,discipline,country,country);
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({requests:rows.map(r=>({
    id:r.id,reference:r.reference,title:r.title,discipline:r.discipline,country:r.country,
    location:r.location,description:r.description,scope:(()=>{try{return JSON.parse(r.scope_json||'[]')}catch(_){return []}})(),
    currency:r.currency,budget_min:r.budget_min,budget_max:r.budget_max,
    closing_at:r.closing_at,created_at:r.created_at,publicView:true
  })),count:rows.length});
});


router.get('/consulting/firm-tenders', (req,res) => {
  const db=getDB(), now=Math.floor(Date.now()/1000);
  const q=clean(req.query.q,120);
  const rows=db.prepare(`
    SELECT t.id,t.reference,t.title,t.discipline,t.country,t.location,t.description,
           t.scope_json,t.currency,t.budget_min,t.budget_max,t.closing_at,t.created_at,
           f.legal_name AS publisher_name
    FROM consulting_firm_tenders t
    INNER JOIN consulting_firms f ON f.id=t.firm_id AND f.verification_status='verified'
    WHERE t.status='open' AND (t.closing_at IS NULL OR t.closing_at>?)
      AND (?='' OR t.title LIKE ? OR t.reference LIKE ? OR t.description LIKE ? OR t.discipline LIKE ?)
    ORDER BY t.created_at DESC LIMIT 200
  `).all(now,q,'%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%');
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({tenders:rows.map(t=>({id:t.id,reference:t.reference,title:t.title,discipline:t.discipline,
    country:t.country,location:t.location,description:t.description,
    scope:(()=>{try{return JSON.parse(t.scope_json||'[]')}catch(_){return []}})(),
    currency:t.currency,budgetMin:t.budget_min,budgetMax:t.budget_max,
    closingAt:t.closing_at,createdAt:t.created_at,publisherName:t.publisher_name
  })),count:rows.length});
});


router.get('/contractor/opportunities/:id', (req,res) => {
  const db=getDB();
  const row=db.prepare("SELECT * FROM tender_opportunities WHERE id=? AND status IN ('open','closed')").get(req.params.id);
  if(!row) return res.status(404).json({error:{code:'NOT_FOUND',message:'العطاء غير موجود أو غير منشور.'}});
  let details={};
  try { details=row.details_json?JSON.parse(row.details_json):{}; } catch (_) { details={}; }
  // TED notice representations are not separate tender attachments. Use
  // the canonical PDF URL generated in the notice's official language.
  // This filters presentation only; stored historical rows are not deleted.
  const tedPdfUrl=row.source_key==='ted'
    ? (Array.isArray(details.officialLinks) && details.officialLinks[0] && details.officialLinks[0].url
        ? details.officialLinks[0].url
        : 'https://ted.europa.eu/'+(details.officialLanguage||'en')+'/notice/'+encodeURIComponent(row.tender_number||'')+'/pdf')
    : '';
  const documents=db.prepare(`
    SELECT id,label,availability,document_url,storage_key,downloaded_at
    FROM tender_opportunity_public_documents
    WHERE opportunity_id=?
      AND (? <> 'ted' OR document_url=?)
    ORDER BY created_at,id
  `).all(row.id,row.source_key,tedPdfUrl).map(doc=>({
    id:doc.id,label:doc.label,availability:doc.availability,
    downloadUrl:doc.availability==='public-source-link' && isAllowedPublicDocumentUrl(row.source_key,doc.document_url)
      ? '/api/public/contractor/opportunities/'+encodeURIComponent(row.id)+'/documents/'+encodeURIComponent(doc.id)+'/download' : null,
    cached:Boolean(doc.storage_key),downloadedAt:doc.downloaded_at?new Date(doc.downloaded_at*1000).toISOString():null
  }));
  res.setHeader('Cache-Control','public, max-age=30');
  res.json({
    opportunity:{
      id:row.id,title:row.title,authority:row.authority,country:row.country,sector:row.sector,
      tenderNumber:row.tender_number,summary:row.summary,publishedAt:row.published_at,
      closingAt:row.closing_at,sourceUrl:row.source_url,applicationUrl:row.application_url,
      status:row.status,language:row.language,sourceKey:row.source_key,importedAt:row.imported_at
    },
    details,documents
  });
});


// HEAD is a metadata-only preflight. Express otherwise falls back to the GET handler,
// which would fetch the TED PDF once for HEAD and again for the actual download.
router.head('/contractor/opportunities/:id/documents/:documentId/download', async (req,res,next) => {
  try {
    const db=getDB();
    const doc=db.prepare(`
      SELECT d.id,d.label,d.availability,d.document_url,o.source_key,o.status
      FROM tender_opportunity_public_documents d
      JOIN tender_opportunities o ON o.id=d.opportunity_id
      WHERE d.id=? AND o.id=? AND o.status IN ('open','closed')
    `).get(req.params.documentId,req.params.id);
    if(!doc) return res.status(404).end();
    if(doc.availability!=='public-source-link' || !isAllowedPublicDocumentUrl(doc.source_key,doc.document_url)) return res.status(403).end();
    if(String(doc.source_key).toLowerCase()!=='ted') return next();
    const filename=safeDocumentFilename(doc.label,doc.document_url,'application/pdf');
    const fallback=filename.replace(/[^\\x20-\\x7e]/g,'_').replace(/["\\\\]/g,'_').slice(0,140)||'tender-notice.pdf';
    const encoded=encodeURIComponent(filename).replace(/[!'()*]/g,ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    return res.status(200).end();
  } catch(err) { next(err); }
});

// Public-source documents may be downloaded without an MMC account.
// Only published notices and explicitly public, allow-listed source URLs are eligible.
router.get('/contractor/opportunities/:id/documents/:documentId/download', async (req,res,next) => {
  try {
    const db=getDB();
    const doc=db.prepare(`
      SELECT d.id,d.label,d.availability,d.document_url,o.source_key,o.status
      FROM tender_opportunity_public_documents d
      JOIN tender_opportunities o ON o.id=d.opportunity_id
      WHERE d.id=? AND o.id=? AND o.status IN ('open','closed')
    `).get(req.params.documentId,req.params.id);
    if(!doc) return res.status(404).json({error:{code:'NOT_FOUND',message:'وثيقة الإعلان غير موجودة أو غير منشورة.'}});
    if(doc.availability!=='public-source-link' || !isAllowedPublicDocumentUrl(doc.source_key,doc.document_url)) {
      return res.status(403).json({error:{code:'DOCUMENT_NOT_PUBLIC',message:'هذه الوثيقة ليست ملفاً عاماً متاحاً للتنزيل دون تسجيل.'}});
    }
    let fetched;
    if (String(doc.source_key).toLowerCase() === 'ted') {
      const relayUrl = String(process.env.TED_PDF_RELAY_URL || '');
      const relayToken = String(process.env.TED_PDF_RELAY_TOKEN || '');
      const expectedRelayUrl = 'https://mmc-international-tenders-preview.onrender.com/api/internal/ted-relay';
      if (relayUrl !== expectedRelayUrl || !relayToken) {
        const error = new Error('خدمة تمرير وثائق TED غير مهيأة في الإنتاج.');
        error.status = 503;
        error.code = 'TED_RELAY_NOT_CONFIGURED';
        throw error;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const relayResponse = await fetch(relayUrl, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + relayToken,
            'Content-Type': 'application/json',
            'Accept': 'application/pdf'
          },
          body: JSON.stringify({ url: doc.document_url }),
          signal: controller.signal
        });
        if (!relayResponse.ok) {
          const relayError = new Error('تعذّر جلب وثيقة TED عبر خدمة الربط الآمنة.');
          relayError.status = relayResponse.status === 401 ? 503 : 502;
          relayError.code = 'TED_RELAY_UPSTREAM_FAILED';
          throw relayError;
        }
        const mime = String(relayResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const buffer = Buffer.from(await relayResponse.arrayBuffer());
        if (mime !== 'application/pdf' || !buffer.length ||
            !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
          const error = new Error('لم تُرجع خدمة TED ملف PDF صالحاً.');
          error.status = 502;
          error.code = 'TED_RELAY_INVALID_PDF';
          throw error;
        }
        fetched = { buffer, mime: 'application/pdf', finalUrl: doc.document_url };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          const timeoutError = new Error('انتهت مهلة الاتصال بخدمة وثائق TED.');
          timeoutError.status = 504;
          timeoutError.code = 'TED_RELAY_TIMEOUT';
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } else {
      fetched = await downloadPublicDocument(doc.source_key,doc.document_url);
    }
    const filename=safeDocumentFilename(doc.label,fetched.finalUrl,fetched.mime);
    const fallback=filename.replace(/[^\\x20-\\x7e]/g,'_').replace(/["\\\\]/g,'_').slice(0,140)||'tender-notice';
    const encoded=encodeURIComponent(filename).replace(/[!'()*]/g,ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type',fetched.mime||'application/octet-stream');
    res.setHeader('Content-Length',String(fetched.buffer.length));
    res.setHeader('Content-Disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','public, max-age=300');
    res.send(fetched.buffer);
  } catch(err) { next(err); }
});

module.exports = router;
