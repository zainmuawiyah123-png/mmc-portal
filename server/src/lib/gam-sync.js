'use strict';
/** Read-only importer for Greater Amman Municipality's public tender list. */
const LIST_URL='https://www.gamtenders.gov.jo/localtenders.aspx', ORIGIN='https://www.gamtenders.gov.jo';
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(+x)).replace(/\s+/g,' ').trim();
function dateISO(v){const m=String(v||'').match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);if(!m)return null;const d=+m[1],mo=+m[2],y=+m[3],dt=new Date(Date.UTC(y,mo-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
function parseGAMRows(html,today){
 const out=[],seen=new Set(),source=String(html||''),todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
 for(const m of source.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  const text=clean(m[2]); if(!text||text.length<8)continue;
  const number=(text.match(/\b\d{1,4}\s*\/\s*\d{1,2}\s*\/\s*202\d\b/)||[])[0]
   ||(text.match(/\b\d{1,4}\s*\/\s*202\d\b/)||[])[0];
  const href=m[1]; let sourceUrl=LIST_URL;
  try{const u=new URL(href,LIST_URL);if(u.origin===ORIGIN&&(u.pathname.toLowerCase().endsWith('.aspx')||u.pathname.toLowerCase().endsWith('.pdf')||u.pathname.toLowerCase().includes('site_doc')||u.pathname.toLowerCase().includes('tender')))sourceUrl=u.toString();}catch(_){}
  const idx=m.index,context=clean(source.slice(Math.max(0,idx-800),Math.min(source.length,idx+m[0].length+1200)));
  const id=number?number.replace(/\s+/g,''):sourceUrl!==LIST_URL?sourceUrl:text;
  if(seen.has(id))continue;
  if(!number&&!/(?:عطاء|مناقصة|توريد|إنشاء|صيانة|تأهيل|تقديم عروض)/i.test(text))continue;
  seen.add(id);
  const dates=[...context.matchAll(/(?:آخر موعد[^:]{0,30}|موعد الإيداع[^:]{0,30}|تاريخ الإغلاق[^:]{0,20})?\s*[:：]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]202\d)/gi)].map(x=>dateISO(x[1])).filter(Boolean);
  const closingAt=dates.length?dates[dates.length-1]:null;
  const title=(number?text.replace(number,'').replace(/^[-–:：\s]+/,'').trim():text).slice(0,300)||text.slice(0,300);
  out.push({id,title,authority:'أمانة عمّان الكبرى / Greater Amman Municipality',country:'JO',
   sector:/أشغال|طرق|أدراج|خرسانة|إنشاء|صيانة|تأهيل|مياه|صرف صحي|حفريات/i.test(title)?'أعمال مدنية وإنشائية':null,
   tenderNumber:number?number.replace(/\s+/g,''):null,
   summary:'إعلان من بوابة العطاءات الرسمية لأمانة عمّان الكبرى. تحقق من الموعد والوثائق وشروط الاشتراك من الإعلان الأصلي.',
   publishedAt:null,closingAt,sourceUrl,applicationUrl:null,status:closingAt&&closingAt<todayISO?'closed':'open',language:'ar'});
 }
 return out;
}
async function syncGAM(){
 const {getDB,uid}=require('../db'),ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000);let html;
 try{const r=await fetch(LIST_URL,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:ctl.signal});if(!r.ok)throw new Error('GAM returned HTTP '+r.status);html=await r.text();}finally{clearTimeout(timer);}
 const rows=parseGAMRows(html);if(!rows.length)throw new Error('GAM page returned no recognizable tender records; no database rows changed.');
 const db=getDB(),up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
 VALUES (@rowId,'gam',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()`);
 const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('gam',n.id);up.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});if(old)updated++;else added++;}return{added,updated};});
 return{...tx(rows),received:rows.length,normalized:rows.length,source:'gam',sourceUrl:LIST_URL};
}
module.exports={parseGAMRows,syncGAM,LIST_URL};
