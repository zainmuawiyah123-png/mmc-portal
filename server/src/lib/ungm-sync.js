'use strict';
/**
 * UNGM agency-notice connector.
 * UNGM documents GET /API/Notices as OAuth authorization-code protected and
 * describes it as notices created by the authorized agency. This connector
 * therefore imports only that authorized agency's notice collection.
 */
const { getDB, uid } = require('../db');
const clean=(v,n=3000)=>String(v==null?'':v).replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,n);
const ISO3_TO_ISO2={JOR:'JO',SAU:'SA',ARE:'AE'};
function normalizeUNGMNotice(row){
 const id=clean(row.Id||row.ID,100),title=clean(row.Title,300);
 if(!id||!title)return null;
 const statusText=clean(row.Status,40).toLowerCase();
 // Only finalized notices are publicly published by UNGM; never expose drafts.
 if(statusText!=='finalized')return null;
 const deadline=clean(row.Deadline,40),published=clean(row.DatePublished,40);
 const iso=Array.isArray(row.CountryISO3Codes)?row.CountryISO3Codes.map(x=>clean(x,3).toUpperCase()):[];
 const country=iso.length===1?(ISO3_TO_ISO2[iso[0]]||'INT'):'INT';
 const expired=deadline&&/^\d{4}-\d{2}-\d{2}/.test(deadline)&&deadline.slice(0,10)<new Date().toISOString().slice(0,10);
 const reference=clean(row.Reference,120);
 const description=clean(row.Description,2500);
 const publicUrl='https://www.ungm.org/Public/Notice';
 return {
  id,title,authority:'United Nations agency (UNGM)',country,sector:null,
  tenderNumber:reference||id,summary:description||'UNGM notice · '+clean(row.Type,100),
  publishedAt:published||null,closingAt:deadline||null,sourceUrl:publicUrl,
  applicationUrl:null,status:expired?'closed':'open',language:'en'
 };
}
async function syncUNGM({accessToken,rows=100,pages=5}={}){
 if(!accessToken)throw new Error('UNGM_ACCESS_TOKEN is not configured.');
 const pageSize=Math.min(100,Math.max(1,rows)),items=[];
 let next='https://www.ungm.org/API/Notices';
 for(let page=0;page<Math.min(10,Math.max(1,pages))&&next;page++){
  const url=new URL(next);
  if(url.origin!=='https://www.ungm.org'||url.pathname!=='/API/Notices')throw new Error('UNGM returned an unexpected pagination URL.');
  if(page===0){url.searchParams.set('$top',String(pageSize));url.searchParams.set('$orderby','DatePublished desc');}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  let payload;
  try{
   const response=await fetch(url,{headers:{Accept:'application/json',Authorization:'Bearer '+accessToken},signal:controller.signal});
   if(!response.ok)throw new Error('UNGM API returned HTTP '+response.status+'; verify token and agency permissions.');
   payload=await response.json();
  }finally{clearTimeout(timer);}
  const values=Array.isArray(payload.value)?payload.value:[];
  items.push(...values);
  const link=payload['@odata.nextLink'];
  next=link?new URL(link,url).toString():null;
  if(values.length<pageSize&&!next)break;
 }
 const mapped=items.map(normalizeUNGMNotice).filter(Boolean),db=getDB();
 const upsert=db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
 VALUES (@rowId,'ungm',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,
 country=excluded.country,sector=excluded.sector,tender_number=excluded.tender_number,
 summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,
 source_url=excluded.source_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()`);
 const tx=db.transaction(rows=>{
  let added=0,updated=0;
  for(const item of rows){
   const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('ungm',item.id);
   upsert.run({rowId:old?old.id:uid('opp_'),externalId:item.id,title:item.title,authority:item.authority,country:item.country,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status,language:item.language});
   if(old)updated++;else added++;
  }
  return {added,updated};
 });
 return {...tx(mapped),received:items.length,normalized:mapped.length,source:'ungm'};
}
module.exports={normalizeUNGMNotice,syncUNGM};
