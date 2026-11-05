'use strict';
/**
 * Read-only connector for the public, server-rendered JONEPS tender invitation list.
 * It never submits bids, logs in, or accesses private procurement records.
 */
const {getDB,uid}=require('../db');
const LIST_URL='https://www.joneps.gov.jo/ep/invt/selectListTendInvitAL.do';
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g,' ').trim();
function dateISO(value){
 const m=String(value||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 if(!m)return null;
 const day=Number(m[1]),month=Number(m[2]),year=Number(m[3]);
 const date=new Date(Date.UTC(year,month-1,day));
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
 return year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
}
function extractPageUrls(html,maxPage=100){
 const found=new Map([[LIST_URL,1]]);
 for(const match of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  const label=clean(match[2]),number=Number(label);
  if(!/^\d+$/.test(label)||number<2||number>Math.min(500,Math.max(2,Number(maxPage)||100)))continue;
  try{
   const url=new URL(match[1],LIST_URL);
   if(url.origin==='https://www.joneps.gov.jo'&&url.pathname==='/ep/invt/selectListTendInvitAL.do')found.set(url.toString(),number);
  }catch(_){}
 }
 return [...found.entries()].sort((a,b)=>a[1]-b[1]).map(x=>x[0]);
}
function parseJonepsRows(html){
 const out=[],trs=String(html||'').match(/<tr\b[\s\S]*?<\/tr>/gi)||[];
 for(let rowIndex=0;rowIndex<trs.length;rowIndex++){
  const tr=trs[rowIndex];
  const cells=[...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);
  if(cells.length<6)continue;
  const number=clean(cells[0]),title=clean(cells[1]),authority=clean(cells[2]),sector=clean(cells[3]);
  if(!/^\d{4,}(?:-\d+)+$/.test(number)||!title)continue;
  const published=dateISO(clean(cells[4])),deadline=dateISO(clean(cells[5]));
  const hrefMatch=(cells[1].match(/<a\b[^>]*href=["']([^"']+)["']/i)||cells[0].match(/<a\b[^>]*href=["']([^"']+)["']/i)||[])[1];
  let sourceUrl=LIST_URL;
  if(hrefMatch){
   try{const u=new URL(hrefMatch,LIST_URL);if(u.origin==='https://www.joneps.gov.jo')sourceUrl=u.toString();}catch(_){}
  }
  const nextCells=[...(trs[rowIndex+1]||'').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
  const stateText=clean(tr)+(nextCells.length<6?clean(trs[rowIndex+1]||''):'');
  const cancelled=/ملغي|ملغى|إلغاء|الغاء|cancelled|canceled/i.test(stateText);
  const expired=deadline&&deadline<new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
  out.push({id:number,title,authority:authority||'جهة حكومية أردنية',country:'JO',sector:sector||null,tenderNumber:number,summary:'إعلان عطاء منشور على نظام الشراء الإلكتروني الأردني JONEPS.',publishedAt:published,closingAt:deadline,sourceUrl,applicationUrl:null,status:cancelled?'cancelled':expired?'closed':'open',language:'ar'});
 }
 return out;
}

const JONEPS_HOSTS=new Set(['www.joneps.gov.jo','joneps.gov.jo']);
function plainDetail(html){
 return clean(String(html||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' '));
}
function parseJonepsDetail(html,sourceUrl){
 const text=plainDetail(html);
 const pick=(patterns)=>{for(const p of patterns){const m=text.match(p);if(m&&m[1])return clean(m[1],1500);}return null;};
 const purchase=pick([/(?:تاريخ\s*(?:شراء|طرح)\s*(?:العطاء|الوثائق)|Purchase\s*Date)\s*:?\s*([\d/.-]+)/i]);
 const closing=pick([/(?:آخر\s*موعد\s*(?:لتقديم|لإيداع)\s*(?:العروض|الاستفسارات)|تاريخ\s*الإغلاق|Closing\s*Date|Submission\s*Deadline)\s*:?\s*([\d/.-]+)/i]);
 const fee=pick([/(?:ثمن\s*(?:نسخة|وثائق)\s*العطاء|رسوم\s*الوثائق|Document\s*Fee)\s*:?\s*(.{1,120}?)(?=\s+(?:كفالة(?:\s+(?:دخول|العطاء))?|Bid\s*Bond|شروط|تصنيف|Eligibility|Qualification|ملاحظات|Remarks)(?:\s|:)|$)/i]);
 const bond=pick([/(?:كفالة(?:\s+دخول)?(?:\s+العطاء)?|Bid\s*Bond)\s*:?\s*(.{1,160}?)(?=\s+(?:شروط|تصنيف|Eligibility|Qualification|ملاحظات|Remarks)(?:\s|:)|$)/i]);
 const qualification=pick([/(?:شروط\s*(?:التأهيل|المشاركة)|تصنيف\s*المقاول|Eligibility|Qualification)\s*:?\s*(.{1,500}?)(?=\s+(?:ملاحظات|Remarks)(?:\s|:)|$)/i]);
 const remarks=pick([/(?:ملاحظات|Remarks)\s*:?\s*(.{1,500}?)(?=\s+(?:جدول\s*الكميات|مخططات|وثائق|documents?|drawings?|specifications?)(?:\s|$)|$)/i]);
 const docs=[],seen=new Set(),re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
 while((m=re.exec(String(html||'')))){
  try{
   const u=new URL(m[1],sourceUrl),label=clean(m[2],180);
   const file=/\.(?:pdf|docx?|xlsx?|zip|dwg|dxf|rar)(?:$|[?#])/i.test(u.pathname+u.search);
   const named=/(?:وثائق|مواصفات|مخططات|جدول\s*الكميات|تحميل|تنزيل|documents?|specifications?|drawings?|download|boq)/i.test(label);
   if(u.protocol==='https:'&&JONEPS_HOSTS.has(u.hostname)&&u.pathname!='/ep/invt/selectListTendInvitAL.do'&&(file||named)&&!seen.has(u.toString())){
    seen.add(u.toString());docs.push({label:label||'وثيقة عطاء عامة',url:u.toString()});
   }
  }catch(_){}
 }
 return {purchase,closing,fee,bond,qualification,remarks,docs,detailUrl:sourceUrl,verified:true};
}
async function fetchJonepsDetail(url){
 const u=new URL(url);
 if(u.protocol!=='https:'||!JONEPS_HOSTS.has(u.hostname))throw new Error('Blocked non-JONEPS detail URL');
 const response=await fetch(u,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:AbortSignal.timeout(18000),redirect:'manual'});
 if(response.status>=300&&response.status<400)throw new Error('JONEPS detail redirect refused');
 if(!response.ok)throw new Error('JONEPS detail returned HTTP '+response.status);
 return parseJonepsDetail(await response.text(),u.toString());
}
function persistJonepsDetails(notices,details){
 const db=getDB(),byId=new Map(details.map(x=>[x.id,x.detail]));
 const tx=db.transaction(()=>{
  let detailsSaved=0,documentsSaved=0;
  for(const n of notices){
   const detail=byId.get(n.id);if(!detail)continue;
   const row=db.prepare("SELECT id,status FROM tender_opportunities WHERE source_key='joneps' AND external_id=?").get(n.id);
   if(!row)continue;
   const verifiedClosing=dateISO(detail.closing);
   if(verifiedClosing){
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
    const status=row.status==='cancelled'?'cancelled':verifiedClosing<today?'closed':'open';
    db.prepare('UPDATE tender_opportunities SET closing_at=?,status=?,updated_at=unixepoch() WHERE id=?').run(verifiedClosing,status,row.id);
   }
   const payload={...detail,detailUrl:n.sourceUrl};
   db.prepare('INSERT INTO tender_opportunity_details (opportunity_id,details_json,verified_at) VALUES (?,?,unixepoch()) ON CONFLICT(opportunity_id) DO UPDATE SET details_json=excluded.details_json,verified_at=unixepoch()').run(row.id,JSON.stringify(payload));
   db.prepare('DELETE FROM tender_opportunity_documents WHERE opportunity_id=?').run(row.id);
   const add=db.prepare("INSERT INTO tender_opportunity_documents (id,opportunity_id,label,document_url,availability) VALUES (?,?,?,?,'public')");
   const crypto=require('crypto');
   for(const doc of detail.docs)add.run('jndoc_'+crypto.createHash('sha1').update(row.id+doc.url).digest('hex'),row.id,doc.label,doc.url);
   detailsSaved++;documentsSaved+=detail.docs.length;
  }
  return {detailsSaved,documentsSaved};
 });
 return tx();
}

async function syncJONEPS({maxPages=100}={}){
 const fetchPage=async url=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
   const u=new URL(url);if(u.protocol!=='https:'||!JONEPS_HOSTS.has(u.hostname))throw new Error('Blocked non-JONEPS listing URL');
   const response=await fetch(u,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:controller.signal,redirect:'manual'});
   if(response.status>=300&&response.status<400)throw new Error('JONEPS listing redirect refused');
   if(!response.ok)throw new Error('JONEPS returned HTTP '+response.status);
   return await response.text();
  }finally{clearTimeout(timer);}
 };
 const firstHtml=await fetchPage(LIST_URL);
 const pageUrls=extractPageUrls(firstHtml,maxPages).slice(0,Math.min(100,Math.max(1,maxPages)));
 const htmlPages=[firstHtml];
 for(const url of pageUrls.slice(1))htmlPages.push(await fetchPage(url));
 const notices=[...new Map(htmlPages.flatMap(parseJonepsRows).map(n=>[n.id,n])).values()];
 if(!notices.length)throw new Error('JONEPS page loaded but no recognizable tender rows were found; importer stopped without changing records.');
 const detailTargets=notices.filter(n=>n.sourceUrl&&n.sourceUrl!==LIST_URL);
 const detailResults=await mapLimit(detailTargets,5,async n=>({id:n.id,detail:await fetchJonepsDetail(n.sourceUrl)}));
 const detailFailures=detailResults.flatMap((x,i)=>x&&x.error?[{id:detailTargets[i].id,message:x.error.message}]:[]);
 const verifiedDetails=detailResults.filter(x=>x&&!x.error);
 const db=getDB();
 const upsert=db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
 VALUES (@rowId,'joneps',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,
 country=excluded.country,sector=excluded.sector,tender_number=excluded.tender_number,
 summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,
 source_url=excluded.source_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()`);
 const tx=db.transaction(rows=>{
  let added=0,updated=0;
  for(const n of rows){
   const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('joneps',n.id);
   upsert.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});
   if(old)updated++;else added++;
  }
  return {added,updated};
 });
 const counts=tx(notices);
 const detailStats=persistJonepsDetails(notices,verifiedDetails);
 return {...counts,...detailStats,received:notices.length,normalized:notices.length,detailFailures:detailFailures.length,failed:detailFailures.length,source:'joneps',sourceUrl:LIST_URL};
}
module.exports={parseJonepsRows,extractPageUrls,parseJonepsDetail,persistJonepsDetails,syncJONEPS,LIST_URL};
