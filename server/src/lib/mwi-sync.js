'use strict';
const {getDB,uid}=require('../db');
const LIST_URL='https://www.mwi.gov.jo/AR/Modules/tenders';
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g,' ').trim();
function dateISO(v){const m=clean(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'):null;}
function parseNotices(html){
 const out=[],seen=new Set();
 const anchors=[...String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
 for(let i=0;i<anchors.length;i++){
  const a=anchors[i],title=clean(a[2]);
  if(!title||title.length<5||/اقرأ المزيد|اقرا المزيد|التالي|السابق|^\d+$/.test(title))continue;
  let url;try{url=new URL(a[1],LIST_URL);if(url.origin!=='https://www.mwi.gov.jo')continue;}catch(_){continue;}
  const context=String(html||'').slice(Math.max(0,a.index-1800),Math.min(String(html||'').length,a.index+a[0].length+1200));
  const numberMatch=context.match(/(?:رقم العطاء|رقم المناقصة|TENDER\s*No\.?|Tender\s*No\.?)\s*[:：]?\s*([A-Z0-9][A-Z0-9\-\/ ]{2,45})/i);
  const dateMatch=context.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  const number=numberMatch?clean(numberMatch[1],80).replace(/\s+/g,' ').trim():url.pathname.split('/').filter(Boolean).slice(-1)[0]||title;
  const key=number+'|'+title;if(seen.has(key))continue;seen.add(key);
  const published=dateMatch?dateISO(dateMatch[1]):null;
  const expired=published&&published<'2000-01-01';
  out.push({id:key,title,authority:'وزارة المياه والري / سلطة المياه الأردنية',country:'JO',sector:'مياه وصرف صحي',tenderNumber:number,summary:'إعلان منشور على الموقع الرسمي لوزارة المياه والري. يرجى مراجعة الإعلان الأصلي للتحقق من الموعد النهائي وشروط التقديم.',publishedAt:published,closingAt:null,sourceUrl:url.toString(),applicationUrl:null,status:'open',language:/[ء-ي]/.test(title)?'ar':'en'});
 }
 return out;
}
async function syncMWI(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);let html;
 try{const res=await fetch(LIST_URL,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:controller.signal});if(!res.ok)throw new Error('MWI returned HTTP '+res.status);html=await res.text();}finally{clearTimeout(timer);}
 const notices=parseNotices(html);if(!notices.length)throw new Error('MWI page loaded but no recognizable notice links were found; no records changed.');
 const db=getDB(),upsert=db.prepare("INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language) VALUES (@rowId,'mwi',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language) ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,source_url=excluded.source_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()");
 const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare("SELECT id FROM tender_opportunities WHERE source_key='mwi' AND external_id=?").get(n.id);upsert.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});if(old)updated++;else added++;}return {added,updated};});
 return {...tx(notices),received:notices.length,normalized:notices.length,source:'mwi',sourceUrl:LIST_URL};
}
module.exports={parseNotices,syncMWI,LIST_URL};
