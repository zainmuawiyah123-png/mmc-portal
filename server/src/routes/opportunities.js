'use strict';
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const { audit } = require('../lib/audit');
const { isAllowedPublicDocumentUrl, downloadPublicDocument, safeDocumentFilename } = require('../lib/public-tender-documents');

const router = express.Router();
const clean = (v, n=500) => String(v == null ? '' : v).trim().slice(0,n);
const validUrl = (v) => {
  if (!v) return null;
  let u; try { u = new URL(String(v)); } catch (_) { throw E.badRequest('الرابط غير صالح.'); }
  if (u.protocol !== 'https:') throw E.badRequest('يجب أن يبدأ الرابط بـ HTTPS.');
  return u.toString();
};
const shape = r => ({
  id:r.id, title:r.title, authority:r.authority, country:r.country, sector:r.sector,
  tenderNumber:r.tender_number, summary:r.summary, publishedAt:r.published_at,
  closingAt:r.closing_at, sourceUrl:r.source_url, applicationUrl:r.application_url,
  status:r.status, language:r.language, sourceKey:r.source_key, importedAt:r.imported_at
});
function refreshExpiredOpportunities(db=getDB(), now=Date.now()) {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date(now));
  const nowIso=new Date(now).toISOString();
  const dateOnly=db.prepare("UPDATE tender_opportunities SET status='closed',updated_at=unixepoch() WHERE status='open' AND closing_at IS NOT NULL AND length(closing_at)=10 AND closing_at<?").run(today).changes;
  const timed=db.prepare("UPDATE tender_opportunities SET status='closed',updated_at=unixepoch() WHERE status='open' AND closing_at IS NOT NULL AND length(closing_at)>10 AND datetime(closing_at)<=datetime(?)").run(nowIso).changes;
  return dateOnly+timed;
}

// Authenticated directory: only published records; no account or internal tender fields.
router.get('/', A.requireAuth, A.requireRole('contractor', 'admin'), wrap(async (req,res) => {
  const db=getDB(); refreshExpiredOpportunities(db);
  const q=clean(req.query.q,120), country=clean(req.query.country,3).toUpperCase();
  const sector=clean(req.query.sector,80), status=clean(req.query.status,20), source=clean(req.query.source,80);
  const clauses=["status IN ('open','closed')"], vals=[];
  if(country){clauses.push('country=?');vals.push(country);}
  if(sector){clauses.push('sector=?');vals.push(sector);}
  if(source){clauses.push('source_key=?');vals.push(source);}
  if(status && ['open','closed'].includes(status)){clauses.push('status=?');vals.push(status);}
  if(q){clauses.push('(title LIKE ? OR authority LIKE ? OR tender_number LIKE ? OR summary LIKE ?)');const like='%'+q+'%';vals.push(like,like,like,like);}
  const rows=db.prepare('SELECT * FROM tender_opportunities WHERE '+clauses.join(' AND ')+' ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, COALESCE(closing_at,\'9999\') ASC, imported_at DESC LIMIT 250').all(...vals);
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({opportunities:rows.map(shape),count:rows.length});
}));

// Unified feed inside the contractor portal: tenders published on the platform by procurement
// offices + external notices (JONEPS, Arab Potash, World Bank, UNGM). Requires a signed-in user.
const ymd = (days=0) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date(Date.now()+days*86400000));
const MARKET_ROLES = ['contractor','admin'];
router.get('/feed', A.requireAuth, A.requireRole(...MARKET_ROLES), wrap(async (req,res) => {
 const db=getDB(); refreshExpiredOpportunities(db);
 const me=req.user.id;
 const q=clean(req.query.q,120), source=clean(req.query.source,20), country=clean(req.query.country,3).toUpperCase();
 const state=req.query.status==='closed'?'closed':'open', sort=req.query.sort==='new'?'new':'closing';
 const within=[7,14,30].includes(Number(req.query.closing))?Number(req.query.closing):0;
 const limit=Math.min(Math.max(parseInt(req.query.limit,10)||24,1),60), offset=Math.max(parseInt(req.query.offset,10)||0,0);
 const today=ymd(0);
 // العطاء مفتوح إذا لم يحن تاريخ إغلاقه، حتى لو لم تُحدَّث حالته بعد في المزامنة
 const OPEN="status='open' AND (closing_at IS NULL OR closing_at>=?)";
 const cl=["status IN ('open','closed')"], vals=[];
 if(state==='open'){cl.push('('+OPEN+')');vals.push(today);} else {cl.push("(status='closed' OR closing_at<?)");vals.push(today);}
 if(source){cl.push('source_key=?');vals.push(source);}
 if(country){cl.push('country=?');vals.push(country);}
 if(within){cl.push('closing_at IS NOT NULL AND closing_at<=?');vals.push(ymd(within));}
 if(req.query.saved==='1'){cl.push('id IN (SELECT opportunity_id FROM opportunity_saved WHERE user_id=?)');vals.push(me);}
 if(q){cl.push('(title LIKE ? OR authority LIKE ? OR tender_number LIKE ? OR summary LIKE ?)');const like='%'+q+'%';vals.push(like,like,like,like);}
 const where=cl.join(' AND ');
 const total=db.prepare('SELECT COUNT(*) n FROM tender_opportunities WHERE '+where).get(...vals).n;
 const order=sort==='new'?'imported_at DESC, COALESCE(closing_at,\'9999-12-31\') ASC':'COALESCE(closing_at,\'9999-12-31\') ASC, imported_at DESC';
 const rows=db.prepare('SELECT * FROM tender_opportunities WHERE '+where+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...vals,limit,offset);
 const savedSet=new Set(rows.length?db.prepare('SELECT opportunity_id FROM opportunity_saved WHERE user_id=? AND opportunity_id IN ('+rows.map(()=>'?').join(',')+')').all(me,...rows.map(r=>r.id)).map(r=>r.opportunity_id):[]);
 const openN=(extra,...v)=>db.prepare('SELECT COUNT(*) n FROM tender_opportunities WHERE ('+OPEN+')'+(extra?' AND '+extra:'')).get(today,...v).n;
 const group=(col)=>Object.fromEntries(db.prepare('SELECT '+col+' k, COUNT(*) n FROM tender_opportunities WHERE ('+OPEN+') GROUP BY '+col).all(today).map(r=>[r.k,r.n]));
 const last=db.prepare("SELECT source_key, MAX(finished_at) t FROM opportunity_sync_runs WHERE status='success' GROUP BY source_key").all();
 res.setHeader('Cache-Control','private, max-age=20');
 res.json({
  opportunities:rows.map(r=>({...shape(r),saved:savedSet.has(r.id)})), total, count:rows.length, hasMore:offset+rows.length<total,
  stats:{open:openN(), closingSoon:openN('closing_at IS NOT NULL AND closing_at<=?',ymd(7)), newThisWeek:openN('imported_at>=?',Math.floor(Date.now()/1000)-7*86400),
   saved:db.prepare('SELECT COUNT(*) n FROM opportunity_saved WHERE user_id=?').get(me).n},
  openBySource:group('source_key'), openByCountry:group('country'),
  connectedSources:['joneps','apc','worldbank','ungm','amman','jprc','jpmc','nepco','austender','findatender','contractsfinder','pcs','sell2wales','etimad-saudi','uae-mof'],
	 lastSyncBySource:Object.fromEntries(last.map(r=>[r.source_key,new Date(r.t*1000).toISOString()]))});
}));

// Tender details and public document links are served inside MMC to signed-in contractors/admins.
router.get('/:id', A.requireAuth, A.requireRole(...MARKET_ROLES), wrap(async (req,res,next) => {
 if(req.params.id==='admin') return next();
 const db=getDB();
 const row=db.prepare("SELECT * FROM tender_opportunities WHERE id=? AND status IN ('open','closed')").get(req.params.id);
 if(!row) throw E.notFound('العطاء غير موجود أو غير منشور.');
 let details={};
 try { details=row.details_json?JSON.parse(row.details_json):{}; } catch (_) { details={}; }
 const documents=db.prepare(`SELECT id,label,availability,document_url,storage_key,content_type,file_size,downloaded_at
   FROM tender_opportunity_public_documents WHERE opportunity_id=? ORDER BY created_at,id`).all(row.id)
   .map(doc=>({
     id:doc.id,label:doc.label,availability:doc.availability,
     downloadUrl:isAllowedPublicDocumentUrl(row.source_key,doc.document_url)
       ? '/api/opportunities/'+encodeURIComponent(row.id)+'/documents/'+encodeURIComponent(doc.id)+'/download' : null,
     cached:Boolean(doc.storage_key), downloadedAt:doc.downloaded_at?new Date(doc.downloaded_at*1000).toISOString():null
   }));
 res.setHeader('Cache-Control','private, max-age=30');
 res.json({opportunity:shape(row),details,documents});
}));

router.get('/:id/documents/:documentId/download', A.requireAuth, A.requireRole(...MARKET_ROLES), wrap(async (req,res) => {
 const db=getDB();
 const doc=db.prepare(`SELECT d.*,o.source_key,o.status AS opportunity_status,o.title AS opportunity_title
   FROM tender_opportunity_public_documents d JOIN tender_opportunities o ON o.id=d.opportunity_id
   WHERE d.id=? AND o.id=? AND o.status IN ('open','closed')`).get(req.params.documentId,req.params.id);
 if(!doc) throw E.notFound('وثيقة العطاء غير موجودة أو غير منشورة.');
 if(doc.availability!=='public-source-link' || !isAllowedPublicDocumentUrl(doc.source_key,doc.document_url)) {
   throw E.forbidden('هذا الملف ليس رابطاً عاماً من نطاق المصدر الرسمي المعتمد.');
 }

 const storageApi=require('../lib/storage');
 const storage=storageApi.getStorage();
 let buffer=null, mime=doc.content_type||'', filename='', cacheState='hit';
 const expectedPrefix='public-tenders/'+doc.source_key+'/';
 if(doc.storage_key && doc.storage_key.startsWith(expectedPrefix)) {
   try {
     buffer=await storage.get(doc.storage_key);
     if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length>require('../config').MAX_FILE_BYTES) buffer=null;
   } catch (_) { buffer=null; }
 }
 if(!buffer) {
   const fetched=await downloadPublicDocument(doc.source_key,doc.document_url);
   buffer=fetched.buffer; mime=fetched.mime; cacheState='stored';
   filename=safeDocumentFilename(doc.label,fetched.finalUrl,fetched.mime);
   storageApi.assertAllowed(filename,buffer.length);
   if(!/^[a-z0-9_]+$/.test(doc.source_key) || !/^[A-Za-z0-9_-]+$/.test(doc.id)) throw E.badRequest('معرّف ملف العطاء غير صالح.');
   const storageKey='public-tenders/'+doc.source_key+'/'+doc.id+fetched.extension;
   try {
     const stored=await storage.put(storageKey,buffer,{mime,originalName:filename});
     db.prepare(`UPDATE tender_opportunity_public_documents SET storage_key=?,storage_driver=?,content_type=?,file_size=?,checksum_sha256=?,downloaded_at=unixepoch()
       WHERE id=? AND document_url=?`).run(stored.key,stored.driver,mime,buffer.length,stored.checksum,doc.id,doc.document_url);
   } catch(err) {
     cacheState='uncached';
     console.warn('[tender-doc] تعذّر حفظ نسخة عامة في التخزين:',String(err&&err.message||err).slice(0,180));
   }
 } else {
   try { filename=safeDocumentFilename(doc.label,doc.document_url,mime); }
   catch (_) {
     const ext=(String(doc.storage_key||'').match(/\.[a-z0-9]{1,8}$/i)||[])[0]||'.bin';
     filename=(String(doc.label||'وثيقة العطاء').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,90)||'وثيقة العطاء')+ext;
   }
 }
 audit({action:'opportunity_document_download',entity:'tender_opportunity_document',entityId:doc.id,userId:req.user.id,ip:req.ip,detail:{opportunityId:doc.opportunity_id,sourceKey:doc.source_key,bytes:buffer.length,cache:cacheState}});
 const fallback=filename.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_').slice(0,140)||'tender-document';
 const encoded=encodeURIComponent(filename).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 res.setHeader('Content-Type',mime||'application/octet-stream');
 res.setHeader('Content-Length',String(buffer.length));
 res.setHeader('Content-Disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-MMC-Document-Cache',cacheState);
 res.setHeader('Cache-Control','private, no-store');
 res.send(buffer);
}));

router.post('/:id/save', A.requireAuth, A.requireRole(...MARKET_ROLES), wrap(async (req,res) => {
 const db=getDB();
 if(!db.prepare('SELECT 1 FROM tender_opportunities WHERE id=?').get(req.params.id)) throw E.notFound('العطاء غير موجود.');
 db.prepare('INSERT OR IGNORE INTO opportunity_saved (user_id,opportunity_id) VALUES (?,?)').run(req.user.id,req.params.id);
 res.json({ok:true,saved:true});
}));
router.delete('/:id/save', A.requireAuth, A.requireRole(...MARKET_ROLES), wrap(async (req,res) => {
 getDB().prepare('DELETE FROM opportunity_saved WHERE user_id=? AND opportunity_id=?').run(req.user.id,req.params.id);
 res.json({ok:true,saved:false});
}));

// MMC administrators curate/import official notices. No public write access.
router.use(A.requireAuth, A.requireRole('admin'));
router.get('/admin/sync-history', wrap(async(req,res)=>{
 const source=clean(req.query.source,80);
 const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
 const clauses=[],values=[];
 if(source){clauses.push('source_key=?');values.push(source);}
 const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
 const rows=getDB().prepare('SELECT id,source_key,started_at,finished_at,status,received,added,updated,duration_ms,error FROM opportunity_sync_runs'+where+' ORDER BY finished_at DESC LIMIT ?').all(...values,limit);
 res.json({runs:rows.map(r=>({...r,startedAt:new Date(r.started_at*1000).toISOString(),finishedAt:new Date(r.finished_at*1000).toISOString()})),count:rows.length});
}));

router.get('/admin', wrap(async(req,res)=>{
 const rows=getDB().prepare('SELECT * FROM tender_opportunities ORDER BY imported_at DESC LIMIT 500').all();
 res.json({opportunities:rows.map(shape),count:rows.length});
}));
router.post('/admin', wrap(async(req,res)=>{
 const b=req.body||{};
 const sourceKey=clean(b.sourceKey,80), externalId=clean(b.externalId,160), title=clean(b.title,300);
 const sourceUrl=validUrl(b.sourceUrl), applicationUrl=validUrl(b.applicationUrl);
 if(!sourceKey||!externalId||!title||!sourceUrl) throw E.badRequest('المصدر والمعرّف والعنوان ورابط المصدر حقول إلزامية.');
 const country=clean(b.country||'JO',2).toUpperCase();
 if(!/^(?:[A-Z]{2}|INT)$/.test(country)) throw E.badRequest('رمز الدولة يجب أن يتكون من حرفين أو INT للدولي.');
 const status=['open','closed','cancelled','draft'].includes(b.status)?b.status:'open';
 const id=uid('opp_'), db=getDB();
 try {
 db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,created_by)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,sourceKey,externalId,title,clean(b.authority,200)||null,country,clean(b.sector,100)||null,clean(b.tenderNumber,120)||null,clean(b.summary,3000)||null,clean(b.publishedAt,40)||null,clean(b.closingAt,40)||null,sourceUrl,applicationUrl,status,clean(b.language,5)||'ar',req.user.id);
 } catch(err) { if(String(err.message).includes('UNIQUE')) throw E.conflict('هذا الإعلان مسجل مسبقاً لهذا المصدر.'); throw err; }
 audit({action:'opportunity_create',entity:'tender_opportunity',entityId:id,userId:req.user.id,ip:req.ip,detail:{sourceKey,country,status}});
 res.status(201).json({opportunity:shape(db.prepare('SELECT * FROM tender_opportunities WHERE id=?').get(id))});
}));
router.patch('/admin/:id', wrap(async(req,res)=>{
 const db=getDB(), row=db.prepare('SELECT * FROM tender_opportunities WHERE id=?').get(req.params.id);
 if(!row) throw E.notFound('الإعلان غير موجود.');
 const b=req.body||{}, fields={
 title: b.title===undefined?row.title:clean(b.title,300),
 authority:b.authority===undefined?row.authority:clean(b.authority,200)||null,
 sector:b.sector===undefined?row.sector:clean(b.sector,100)||null,
 summary:b.summary===undefined?row.summary:clean(b.summary,3000)||null,
 closing_at:b.closingAt===undefined?row.closing_at:clean(b.closingAt,40)||null,
 published_at:b.publishedAt===undefined?row.published_at:clean(b.publishedAt,40)||null,
 source_url:b.sourceUrl===undefined?row.source_url:validUrl(b.sourceUrl),
 application_url:b.applicationUrl===undefined?row.application_url:validUrl(b.applicationUrl),
 status:b.status===undefined?row.status:b.status
 };
 if(!fields.title||!['open','closed','cancelled','draft'].includes(fields.status)) throw E.badRequest('العنوان أو حالة الإعلان غير صحيحة.');
 db.prepare(`UPDATE tender_opportunities SET title=?,authority=?,sector=?,summary=?,closing_at=?,published_at=?,source_url=?,application_url=?,status=?,updated_at=unixepoch() WHERE id=?`).run(fields.title,fields.authority,fields.sector,fields.summary,fields.closing_at,fields.published_at,fields.source_url,fields.application_url,fields.status,row.id);
 audit({action:'opportunity_update',entity:'tender_opportunity',entityId:row.id,userId:req.user.id,ip:req.ip,detail:{status:fields.status}});
 res.json({opportunity:shape(db.prepare('SELECT * FROM tender_opportunities WHERE id=?').get(row.id))});
}));

router.post('/admin/bulk', wrap(async(req,res)=>{
 const rows=Array.isArray(req.body?.opportunities)?req.body.opportunities:null;
 if(!rows||!rows.length||rows.length>100) throw E.badRequest('أرسل من 1 إلى 100 إعلان في الدفعة الواحدة.');
 const db=getDB(), insert=db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,created_by)
 VALUES (@id,@source_key,@external_id,@title,@authority,@country,@sector,@tender_number,@summary,@published_at,@closing_at,@source_url,@application_url,@status,@language,@created_by)
 ON CONFLICT(source_key,external_id) DO UPDATE SET
 title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,
 tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
 closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,
 status=excluded.status,language=excluded.language,updated_at=unixepoch()`);
 const tx=db.transaction(items=>{
  let added=0,updated=0;
  for(const b of items){
   const source_key=clean(b.sourceKey,80),external_id=clean(b.externalId,160),title=clean(b.title,300),source_url=validUrl(b.sourceUrl);
   if(!source_key||!external_id||!title||!source_url) throw E.badRequest('كل إعلان يتطلب sourceKey وexternalId وtitle وsourceUrl صحيحاً.');
   const country=clean(b.country||'JO',2).toUpperCase();
   if(!/^(?:[A-Z]{2}|INT)$/.test(country)) throw E.badRequest('رمز الدولة غير صحيح.');
   const status=['open','closed','cancelled','draft'].includes(b.status)?b.status:'open';
   const exists=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get(source_key,external_id);
   const id=exists?exists.id:uid('opp_');
   insert.run({id,source_key,external_id,title,authority:clean(b.authority,200)||null,country,sector:clean(b.sector,100)||null,tender_number:clean(b.tenderNumber,120)||null,summary:clean(b.summary,3000)||null,published_at:clean(b.publishedAt,40)||null,closing_at:clean(b.closingAt,40)||null,source_url,application_url:validUrl(b.applicationUrl),status,language:clean(b.language,5)||'ar',created_by:req.user.id});
   if(exists)updated++;else added++;
  }
  return {added,updated};
 });
 const result=tx(rows);
 audit({action:'opportunity_bulk_import',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:result});
 res.json({ok:true,...result,processed:rows.length});
}));

async function runAndRecordSync(source,fn) {
 const started=Date.now();
 try { const result=await fn(); require('../lib/scheduler').persistOpportunitySync(source,started,{ok:true,...result}); return result; }
 catch(err) { require('../lib/scheduler').persistOpportunitySync(source,started,{ok:false,error:err.message||String(err)}); throw err; }
}

router.post('/admin/sync/vendorpanel-australia', wrap(async(req,res)=>{
 const result=await runAndRecordSync('vendorpanel-australia',()=>require('../lib/vendorpanel-australia-sync').syncVendorPanelAustralia());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'vendorpanel-australia',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/austender', wrap(async(req,res)=>{
 const result=await runAndRecordSync('austender',()=>require('../lib/austender-sync').syncAusTender());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'austender',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/worldbank', wrap(async(req,res)=>{
 const result=await runAndRecordSync('worldbank',()=>require('../lib/opportunity-sync').syncWorldBank({rows:100,offset:0,pages:5}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'worldbank',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/findatender', wrap(async(req,res)=>{
 const result=await runAndRecordSync('findatender',()=>require('../lib/uk-public-procurement-sync').syncFindATender({days:14,maxPages:10}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'findatender',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));
router.post('/admin/sync/contractsfinder', wrap(async(req,res)=>{
 const result=await runAndRecordSync('contractsfinder',()=>require('../lib/uk-public-procurement-sync').syncContractsFinder({days:30,maxPages:5}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'contractsfinder',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/sell2wales', wrap(async(req,res)=>{
 const result=await runAndRecordSync('sell2wales',()=>require('../lib/uk-public-procurement-sync').syncSell2Wales({months:2}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'sell2wales',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/pcs', wrap(async(req,res)=>{
 const result=await runAndRecordSync('pcs',()=>require('../lib/uk-public-procurement-sync').syncPublicContractsScotland({months:2}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'pcs',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/ungm', wrap(async(req,res)=>{
 const token=require('../config').UNGM_ACCESS_TOKEN;
 if(!token) throw E.conflict('لم يتم إعداد رمز UNGM في إعدادات الخادم بعد.');
 const result=await runAndRecordSync('ungm',()=>require('../lib/ungm-sync').syncUNGM({accessToken:token,rows:100,pages:5}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'ungm',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

router.post('/admin/sync/joneps', wrap(async(req,res)=>{
 const result=await runAndRecordSync('joneps',()=>require('../lib/joneps-sync').syncJONEPS());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'joneps',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));
router.post('/admin/sync/apc', wrap(async(req,res)=>{
 const result=await runAndRecordSync('apc',()=>require('../lib/apc-sync').syncAPC());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'apc',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));
router.post('/admin/sync/jprc', wrap(async(req,res)=>{
 const result=await runAndRecordSync('jprc',()=>require('../lib/jprc-sync').syncJPRC());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'jprc',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));
router.post('/admin/sync/nepco', wrap(async(req,res)=>{
 const result=await runAndRecordSync('nepco',()=>require('../lib/nepco-sync').syncNEPCO());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'nepco',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));
router.post('/admin/import/jpmc-curated', wrap(async(req,res)=>{
 const result=await runAndRecordSync('jpmc',()=>require('../lib/jpmc-curated-sync').syncJPMCCurated());
 audit({action:'opportunity_curated_import',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'jpmc',added:result.added,updated:result.updated,received:result.received,verifiedAt:result.verifiedAt}});
 res.json({ok:true,...result});
}));
router.post('/admin/import/amman-curated', wrap(async(req,res)=>{
 const result=await runAndRecordSync('amman',()=>require('../lib/gam-curated-sync').syncGAMCurated());
 audit({action:'opportunity_curated_import',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'amman',added:result.added,updated:result.updated,received:result.received,verifiedAt:result.verifiedAt}});
 res.json({ok:true,...result});
}));
router.post('/admin/import/ungm-jordan-curated', wrap(async(req,res)=>{
 const result=await runAndRecordSync('ungm',()=>require('../lib/ungm-curated-sync').syncUNGMCurated());
 audit({action:'opportunity_curated_import',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'ungm',added:result.added,updated:result.updated,received:result.received,verifiedAt:result.verifiedAt}});
 res.json({ok:true,...result});
}));
router.refreshExpiredOpportunities=refreshExpiredOpportunities;
module.exports=router;
