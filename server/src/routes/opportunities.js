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
  const db=getDB(), q=clean(req.query.q,120), country=clean(req.query.country,2).toUpperCase();
  const sector=clean(req.query.sector,80), status=clean(req.query.status,20);
  const clauses=["status IN ('open','closed')"], vals=[];
  if(country){clauses.push('country=?');vals.push(country);}
  if(sector){clauses.push('sector=?');vals.push(sector);}
  if(status && ['open','closed'].includes(status)){clauses.push('status=?');vals.push(status);}
  if(q){clauses.push('(title LIKE ? OR authority LIKE ? OR tender_number LIKE ? OR summary LIKE ?)');const like='%'+q+'%';vals.push(like,like,like,like);}
  const rows=db.prepare('SELECT * FROM tender_opportunities WHERE '+clauses.join(' AND ')+' ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, COALESCE(closing_at,\'9999\') ASC, imported_at DESC LIMIT 250').all(...vals);
  res.setHeader('Cache-Control','public, max-age=60');
  res.json({opportunities:rows.map(shape),count:rows.length});
}));

// MMC administrators curate/import official notices. No public write access.
router.use(A.requireAuth, A.requireRole('admin'));
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
 if(!/^[A-Z]{2}$/.test(country)) throw E.badRequest('رمز الدولة يجب أن يتكون من حرفين.');
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
module.exports=router;
