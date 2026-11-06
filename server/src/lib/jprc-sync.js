'use strict';
/** Read-only importer for public Jordan Petroleum Refinery Company tender notices. */
const LIST_URL='https://jopetrol.com.jo/ar/modules/tenders', ORIGIN='https://jopetrol.com.jo';
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
 .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
 .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim();
function dateISO(v){const m=String(v||'').match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);if(!m)return null;const y=+m[1],mo=+m[2],d=+m[3],dt=new Date(Date.UTC(y,mo-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
function parseJprcRows(html,today){const out=[],seen=new Set(),todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  const body=clean(m[2]);if(!/رقم العطاء\s*:/i.test(body)||!/موضوع العطاء\s*:/i.test(body))continue;
  const num=(body.match(/رقم العطاء\s*:\s*([^ ]+(?:\s*\/\s*\d{4})?)/i)||[])[1];if(!num)continue;
  const title=(body.match(/موضوع العطاء\s*:\s*([\s\S]*?)\s+تاريخ طرح العطاء/i)||[])[1]||body;
  const publishedAt=dateISO((body.match(/تاريخ طرح العطاء\s*:\s*(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})/i)||[])[1]);
  const closingAt=dateISO((body.match(/تاريخ الاغلاق\s*:\s*(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})/i)||[])[1]);
  let sourceUrl=LIST_URL;try{const u=new URL(m[1],LIST_URL);if(u.origin===ORIGIN)sourceUrl=u.toString();}catch(_){}
  const id=num.replace(/\s+/g,'');if(seen.has(id))continue;seen.add(id);
  out.push({id,title:title.trim().slice(0,300),authority:'شركة مصفاة البترول الأردنية / Jordan Petroleum Refinery Company',country:'JO',
   sector:/اشغال|أعمال مدنية|إنشاء|صيانة|خزانات|مباني/i.test(title)?'أعمال مدنية وإنشائية':null,tenderNumber:id,
   summary:'إعلان عطاء من الموقع الرسمي لمصفاة البترول الأردنية. قد تتطلب وثائق العطاء التسجيل عبر بوابة الموردين.',
   publishedAt,closingAt,sourceUrl,applicationUrl:null,status:closingAt&&closingAt<todayISO?'closed':'open',language:'ar'});
 }return out;}
async function syncJPRC(){const {getDB,uid}=require('../db');const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000);let html;
 try{const r=await fetch(LIST_URL,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:ctl.signal});if(!r.ok)throw new Error('JPRC returned HTTP '+r.status);html=await r.text();}finally{clearTimeout(timer);}
 const rows=parseJprcRows(html);if(!rows.length)throw new Error('JPRC page returned no recognizable tender rows; no records changed.');
 const db=getDB(),up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
 VALUES (@rowId,'jprc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()`);
 const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jprc',n.id);up.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});if(old)updated++;else added++;}return{added,updated};});
 return{...tx(rows),received:rows.length,normalized:rows.length,source:'jprc',sourceUrl:LIST_URL};}
module.exports={parseJprcRows,syncJPRC,LIST_URL};
