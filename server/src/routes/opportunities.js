'use strict';
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const { audit } = require('../lib/audit');

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

// Public directory: only published records; no account or internal tender fields.
router.get('/', wrap(async (req,res) => {
  const db=getDB(), q=clean(req.query.q,120), country=clean(req.query.country,3).toUpperCase();
  const sector=clean(req.query.sector,80), status=clean(req.query.status,20);
  const authority=clean(req.query.authority,120);
  const closingFrom=clean(req.query.closingFrom,10), closingTo=clean(req.query.closingTo,10);
  const validDate=v=>!v||(/^\\d{4}-\\d{2}-\\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
  if(!validDate(closingFrom)||!validDate(closingTo)) throw E.badRequest('صيغة تاريخ الإغلاق يجب أن تكون YYYY-MM-DD.');
  if(closingFrom&&closingTo&&closingFrom>closingTo) throw E.badRequest('بداية فترة الإغلاق يجب ألا تتجاوز نهايتها.');
  const clauses=["status IN ('open','closed')"], vals=[];
  if(country){clauses.push('country=?');vals.push(country);}
  if(sector){clauses.push('sector LIKE ?');vals.push('%'+sector+'%');}
  if(authority){clauses.push('authority LIKE ?');vals.push('%'+authority+'%');}
  if(closingFrom){clauses.push('closing_at>=?');vals.push(closingFrom);}
  if(closingTo){clauses.push('closing_at<=?');vals.push(closingTo);}
  if(status && ['open','closed'].includes(status)){clauses.push('status=?');vals.push(status);}
  if(q){clauses.push('(title LIKE ? OR authority LIKE ? OR tender_number LIKE ? OR summary LIKE ?)');const like='%'+q+'%';vals.push(like,like,like,like);}
  const rows=db.prepare('SELECT * FROM tender_opportunities WHERE '+clauses.join(' AND ')+' ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, COALESCE(closing_at,\'9999\') ASC, imported_at DESC LIMIT 250').all(...vals);
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({opportunities:rows.map(shape),count:rows.length});
}));

// Internal tender detail and document index. The browser stays on MMC.
router.get('/detail/:id', wrap(async(req,res)=>{
 const db=getDB(), row=db.prepare("SELECT * FROM tender_opportunities WHERE id=? AND status IN ('open','closed')").get(req.params.id);
 if(!row) throw E.notFound('العطاء غير موجود في دليل MMC.');
 const detail=db.prepare('SELECT details_json,verified_at FROM tender_opportunity_details WHERE opportunity_id=?').get(row.id);
 const documents=db.prepare('SELECT id,label,availability FROM tender_opportunity_documents WHERE opportunity_id=? ORDER BY label').all(row.id);
 let details={}; try{details=detail?JSON.parse(detail.details_json):{};}catch(_){}
 res.json({opportunity:shape(row),details:{purchaseDate:details.purchase||null,closingDate:details.closing||null,documentFee:details.fee||null,bidBond:details.bond||null,qualification:details.qual||null,remarks:details.remarks||null,verifiedAt:detail?.verified_at||null},documents});
}));

router.get('/documents/:docId', wrap(async(req,res)=>{
 const row=getDB().prepare(`SELECT document_url,label FROM tender_opportunity_documents WHERE id=? AND availability='public'`).get(req.params.docId);
 if(!row) throw E.notFound('الوثيقة غير متاحة داخل MMC.');
 const target=new URL(row.document_url);
 if(target.protocol!=='https:'||!['www.arabpotash.com','arabpotash.com'].includes(target.hostname)) throw E.badRequest('مصدر الوثيقة غير معتمد.');
 const upstream=await fetch(target,{headers:{'user-agent':'MMC-Tender-Directory/1.0','accept':'application/pdf,application/octet-stream,*/*'},signal:AbortSignal.timeout(20000),redirect:'manual'});
 if(upstream.status>=300&&upstream.status<400) throw E.conflict('رفض MMC إعادة توجيه ملف العطاء إلى مصدر آخر غير متحقق منه.');
 if(!upstream.ok) throw E.conflict('تعذر جلب الملف من المصدر العام حالياً.');
 const type=upstream.headers.get('content-type')||'application/octet-stream';
 if(!(type.startsWith('application/pdf')||type.startsWith('application/octet-stream')||type.startsWith('application/zip')||type.startsWith('image/'))) throw E.conflict('المصدر لم يُرجع ملفاً قابلاً للتنزيل.');
 res.setHeader('Content-Type',type);
 res.setHeader('Content-Disposition','inline; filename="MMC-tender-document"');
 res.setHeader('Cache-Control','private, max-age=300');
 const {Readable}=require('stream'); Readable.fromWeb(upstream.body).pipe(res);
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

router.post('/admin/sync/worldbank', wrap(async(req,res)=>{
 const result=await runAndRecordSync('worldbank',()=>require('../lib/opportunity-sync').syncWorldBank({rows:100,offset:0,pages:5}));
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'worldbank',added:result.added,updated:result.updated,received:result.received}});
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
 const result=await runAndRecordSync('arab-potash-company',()=>require('../lib/apc-sync').syncAPC());
 audit({action:'opportunity_source_sync',entity:'tender_opportunity',userId:req.user.id,ip:req.ip,detail:{source:'arab-potash-company',added:result.added,updated:result.updated,received:result.received}});
 res.json({ok:true,...result});
}));

module.exports=router;
