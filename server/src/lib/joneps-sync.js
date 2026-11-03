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
 return m?m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'):null;
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
async function syncJONEPS({maxPages=100}={}){
 const fetchPage=async url=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch(url,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:controller.signal});
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
 return {...tx(notices),received:notices.length,normalized:notices.length,source:'joneps',sourceUrl:LIST_URL};
}
module.exports={parseJonepsRows,extractPageUrls,syncJONEPS,LIST_URL};
