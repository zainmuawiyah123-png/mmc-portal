'use strict';
/**
 * Regional public tender connectors.
 * These connectors only read publicly available notice feeds/pages; they never
 * log in, buy documents, submit bids, or bypass anti-bot controls.
 *
 * Configure a structured JSON feed for each source when the issuing portal
 * exposes one. The feed may be an array or {items:[...]}; fields are normalized
 * into the shared tender_opportunities table.
 */
const { getDB, uid } = require('../db');
const config = require('../config');

const SOURCES = {
  etimad: { country:'SA', authority:'منصة اعتماد السعودية', url:'https://tenders.etimad.sa/Tender/AllTendersForVisitor', feed:config.ETIMAD_FEED_URL },
  uae_mof: { country:'AE', authority:'وزارة المالية الإماراتية — منصة المشتريات الرقمية', url:'https://mof.gov.ae/supplier-registration-in-federal-supplier-register/', feed:config.UAE_MOF_FEED_URL },
  iraq: { country:'IQ', authority:'بوابة المشتريات والعطاءات العراقية', url:'https://www.mof.gov.iq/', feed:config.IRAQ_TENDERS_FEED_URL },
  jordan_private: { country:'JO', authority:'القطاع الخاص والمنظمات في الأردن', url:'https://www.tender.jo/default.aspx?country=jo&lang=ar', feed:config.JORDAN_PRIVATE_FEED_URL }
};

const clean=(v,n=3000)=>String(v==null?'':v).trim().slice(0,n);
const first=(o,keys)=>{for(const k of keys) if(o && o[k]!=null && clean(o[k])) return o[k]; return null;};
function normalize(item, sourceKey){
  const s=SOURCES[sourceKey];
  const id=clean(first(item,['id','external_id','externalId','reference','tender_number','tenderNumber']),160);
  const title=clean(first(item,['title','name','subject','tender_name','tenderName','description']),300);
  if(!id||!title) return null;
  const raw=clean(first(item,['source_url','sourceUrl','url','notice_url']),1000);
  const sourceUrl=/^https:\/\//i.test(raw)?raw:s.url;
  const application=clean(first(item,['application_url','applicationUrl','apply_url','submission_url']),1000);
  const closing=clean(first(item,['closing_at','closingAt','deadline','deadline_date','submission_date']),40)||null;
  const status=closing && /^\d{4}-\d{2}-\d{2}/.test(closing) && closing.slice(0,10)<new Date().toISOString().slice(0,10)?'closed':'open';
  return {id,title,authority:clean(first(item,['authority','entity','agency','issuer']),200)||s.authority,country:s.country,sector:clean(first(item,['sector','category','activity']),100)||null,tenderNumber:id,summary:clean(first(item,['summary','description','details']),2500)||title,publishedAt:clean(first(item,['published_at','publishedAt','publication_date','date']),40)||null,closingAt:closing,sourceUrl,applicationUrl:/^https:\/\//i.test(application)?application:null,status,language:'ar',sourceType:sourceKey==='jordan_private'?'private':'official',trustLevel:sourceKey==='jordan_private'?'review':'verified',tags:first(item,['tags','keywords'])||null};
}
async function fetchItems(sourceKey){
  const s=SOURCES[sourceKey];
  if(!s.feed) return {items:[], skipped:true, error:'لا يوجد رابط JSON عام مهيأ لهذا المصدر؛ لم تتم محاولة تجاوز تسجيل الدخول أو الحماية.'};
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),25000);
  try{
    const r=await fetch(s.feed,{headers:{Accept:'application/json','User-Agent':'MMC-Tender-Directory/1.0'},signal:controller.signal});
    if(!r.ok) throw new Error(sourceKey+' feed returned HTTP '+r.status);
    const p=await r.json(); const items=Array.isArray(p)?p:(Array.isArray(p.items)?p.items:Array.isArray(p.data)?p.data:[]);
    return {items};
  } finally {clearTimeout(timer);}
}
async function syncRegionalSource(sourceKey){
  if(!SOURCES[sourceKey]) throw new Error('Unknown regional source: '+sourceKey);
  const loaded=await fetchItems(sourceKey);
  if(loaded.skipped) return {source:sourceKey,received:0,normalized:0,added:0,updated:0,skipped:true,error:loaded.error};
  const mapped=loaded.items.map(x=>normalize(x,sourceKey)).filter(Boolean), db=getDB();
  const upsert=db.prepare(`INSERT INTO tender_opportunities
   (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,source_type,trust_level,tags_json)
   VALUES (@rowId,@sourceKey,@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@sourceType,@trustLevel,@tagsJson)
   ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,status=excluded.status,language=excluded.language,source_type=excluded.source_type,trust_level=excluded.trust_level,tags_json=excluded.tags_json,updated_at=unixepoch()`);
  const tx=db.transaction(items=>{let added=0,updated=0;for(const x of items){const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get(sourceKey,x.id);upsert.run({rowId:old?old.id:uid('opp_'),sourceKey,externalId:x.id,title:x.title,authority:x.authority,country:x.country,sector:x.sector,tenderNumber:x.tenderNumber,summary:x.summary,publishedAt:x.publishedAt,closingAt:x.closingAt,sourceUrl:x.sourceUrl,applicationUrl:x.applicationUrl,status:x.status,language:x.language,sourceType:x.sourceType,trustLevel:x.trustLevel,tagsJson:x.tags?JSON.stringify(x.tags):null});old?updated++:added++;}return {added,updated};});
  return {...tx(mapped),source:sourceKey,received:loaded.items.length,normalized:mapped.length};
}
async function syncRegionalSources(){const out={};for(const k of Object.keys(SOURCES)){try{out[k]={ok:true,...await syncRegionalSource(k)};}catch(e){out[k]={ok:false,error:String(e.message||e)};}}return out;}
module.exports={SOURCES,normalize,fetchItems,syncRegionalSource,syncRegionalSources};
