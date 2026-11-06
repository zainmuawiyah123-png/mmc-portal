'use strict';
/** Read-only importer for public Jordan Petroleum Refinery Company tender notices. */
const LIST_URL='https://jopetrol.com.jo/ar/modules/tenders', ORIGIN='https://jopetrol.com.jo';
const HOSTS=new Set(['jopetrol.com.jo','www.jopetrol.com.jo']);
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
 .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
 .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(+x)).replace(/\s+/g,' ').trim();
function dateISO(v){const m=String(v||'').match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);if(!m)return null;const y=+m[1],mo=+m[2],d=+m[3],dt=new Date(Date.UTC(y,mo-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
function parseJprcRows(html,today){
 const out=[],seen=new Set(),todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  const body=clean(m[2]);if(!/رقم العطاء\s*:/i.test(body)||!/موضوع العطاء\s*:/i.test(body))continue;
  const num=(body.match(/رقم العطاء\s*:\s*([^ ]+(?:\s*\/\s*\d{4})?)/i)||[])[1];if(!num)continue;
  const title=(body.match(/موضوع العطاء\s*:\s*([\s\S]*?)\s+تاريخ طرح العطاء/i)||[])[1]||body;
  const publishedAt=dateISO((body.match(/تاريخ طرح العطاء\s*:\s*(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})/i)||[])[1]);
  const closingAt=dateISO((body.match(/تاريخ الاغلاق\s*:\s*(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})/i)||[])[1]);
  const fee=(body.match(/سعر النسخة\s*:\s*([^ ]+(?:\s+\w+){0,2})/i)||[])[1]||null;
  const classification=(body.match(/التصنيف\s*:\s*([\s\S]{1,160})$/i)||[])[1]||null;
  let sourceUrl=LIST_URL;
  try{const u=new URL(m[1],LIST_URL);if(u.protocol==='https:'&&u.origin===ORIGIN&&/^\/(?:Ar|ar)\/TendersDetails\//i.test(u.pathname))sourceUrl=u.toString();}catch(_){}
  const id=num.replace(/\s+/g,'');if(seen.has(id))continue;seen.add(id);
  const summary=[
   fee?'سعر نسخة العطاء: '+fee:null,
   classification?'التصنيف: '+classification:null,
   'يمكن مراجعة تفاصيل الإعلان داخل MMC؛ وقد يتطلب شراء الوثائق التسجيل في بوابة الموردين.'
  ].filter(Boolean).join(' | ');
  out.push({id,title:title.trim().slice(0,300),authority:'شركة مصفاة البترول الأردنية / Jordan Petroleum Refinery Company',country:'JO',
   sector:/اشغال|أعمال مدنية|إنشاء|صيانة|خزانات|مباني/i.test(title)?'أعمال مدنية وإنشائية':null,tenderNumber:id,summary,
   publishedAt,closingAt,sourceUrl,applicationUrl:null,status:closingAt&&closingAt<todayISO?'closed':'open',language:'ar'});
 }
 return out;
}
function parseJprcDetail(html,sourceUrl){
 const raw=String(html||'').replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
 const text=clean(raw);
 const pick=(patterns,max=500)=>{for(const re of patterns){const m=text.match(re);if(m&&m[1])return clean(m[1]).slice(0,max);}return null;};
 const bidBond=pick([/كفالة\s*(?:الدخول)?\s*[:：]\s*([^|]{1,180}?)(?=\s+(?:شهادة|موعد|الحصول|المرفقات|$))/i,/كفالة\s*الدخول\s*[:：]\s*([^|]{1,180})/i],180);
 const qualification=pick([/شهادة\s*التصنيف(?:\s*المطلوبة)?\s*[:：]\s*([^|]{1,300}?)(?=\s+(?:موعد|الحصول|المرفقات|$))/i,/التصنيف\s*[:：]\s*([^|]{1,300})/i],300);
 const visitDate=pick([/موعد\s*(?:الزيارة|زيارة\s*الموقع)\s*[:：]?\s*([^|]{1,180}?)(?=\s+(?:الحصول|المرفقات|$))/i],180);
 const documentInstructions=pick([/(الحصول على نسخة[\s\S]{1,700}?)(?=\s+(?:المرفقات|شارك|العطاءات المنتهية|$))/i],700);
 const documentFee=pick([/سعر\s*(?:نسخة|النسخة)\s*[:：]\s*([^|]{1,80})/i],80);
 const docs=[],seen=new Set();
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  try{
   const u=new URL(m[1],sourceUrl),label=clean(m[2]).slice(0,180);
   const file=/\.(?:pdf|docx?|xlsx?|zip|rar|dwg|dxf)(?:$|[?#])/i.test(u.pathname+u.search);
   const named=/(?:مرفقات|مرفق|ملخص|شروط|وثائق|مواصفات|مخططات|جدول الكميات|تحميل|تنزيل|attachment|document|specification|drawing|download)/i.test(label);
   if(u.protocol==='https:'&&HOSTS.has(u.hostname)&&u.pathname!=='/ar/modules/tenders'&&(file||named)&&!seen.has(u.toString())){
    seen.add(u.toString());docs.push({label:label||'مرفق العطاء',url:u.toString()});
   }
  }catch(_){}
 }
 const remarks=visitDate?'موعد الزيارة: '+visitDate:null;
 return {bidBond,qualification,visitDate,documentFee,documentInstructions,remarks,detailUrl:sourceUrl,
  documentsDownloadable:docs.length>0,documentsNote:docs.length?'المرفقات العامة المتاحة مدرجة أدناه. قد تتطلب وثائق العطاء الكاملة التسجيل وشراء النسخة عبر بوابة الموردين.':'لم يُعثر على مرفقات عامة قابلة للتنزيل في صفحة التفاصيل؛ قد تتطلب الوثائق التسجيل وشراء النسخة عبر بوابة الموردين.',
  docs,verified:true};
}
async function fetchJprcDetail(url){
 const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||!/^\/(?:Ar|ar)\/TendersDetails\//i.test(u.pathname))throw new Error('Blocked non-JPRC tender detail URL');
 const response=await fetch(u,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:AbortSignal.timeout(18000),redirect:'manual'});
 if(response.status>=300&&response.status<400)throw new Error('JPRC detail redirect refused');
 if(!response.ok)throw new Error('JPRC detail returned HTTP '+response.status);
 return parseJprcDetail(await response.text(),u.toString());
}
async function mapLimit(items,limit,fn){
 const out=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(error){out[i]={error};}}}));
 return out;
}
function persistJprcDetails(notices,details){
 const {getDB}=require('../db'),db=getDB(),byId=new Map(details.map(x=>[x.id,x.detail]));
 const tx=db.transaction(()=>{
  let detailsSaved=0,documentsSaved=0;
  for(const n of notices){
   const detail=byId.get(n.id);if(!detail)continue;
   const row=db.prepare("SELECT id FROM tender_opportunities WHERE source_key='jprc' AND external_id=?").get(n.id);
   if(!row)continue;
   db.prepare('INSERT INTO tender_opportunity_details (opportunity_id,details_json,verified_at) VALUES (?,?,unixepoch()) ON CONFLICT(opportunity_id) DO UPDATE SET details_json=excluded.details_json,verified_at=unixepoch()').run(row.id,JSON.stringify(detail));
   db.prepare('DELETE FROM tender_opportunity_documents WHERE opportunity_id=?').run(row.id);
   const insert=db.prepare("INSERT INTO tender_opportunity_documents (id,opportunity_id,label,document_url,availability) VALUES (?,?,?,?,'public')");
   const crypto=require('crypto'),unique=new Map((detail.docs||[]).map(doc=>[doc.url,doc]));
   for(const doc of unique.values())insert.run('jprcdoc_'+crypto.createHash('sha1').update(n.id+doc.url).digest('hex'),row.id,doc.label,doc.url);
   detailsSaved++;documentsSaved+=unique.size;
  }
  return {detailsSaved,documentsSaved};
 });
 return tx();
}
async function syncJPRC(){
 const {getDB,uid}=require('../db'),ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000);let html;
 try{
  const r=await fetch(LIST_URL,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:ctl.signal,redirect:'manual'});
  if(r.status>=300&&r.status<400)throw new Error('JPRC listing redirect refused');
  if(!r.ok)throw new Error('JPRC returned HTTP '+r.status);html=await r.text();
 }finally{clearTimeout(timer);}
 const rows=parseJprcRows(html);if(!rows.length)throw new Error('JPRC page returned no recognizable tender rows; no records changed.');
 const targets=rows.filter(n=>n.sourceUrl!==LIST_URL),results=await mapLimit(targets,5,async n=>({id:n.id,detail:await fetchJprcDetail(n.sourceUrl)}));
 const failures=results.filter(x=>x&&x.error).length,verified=results.filter(x=>x&&!x.error);
 const db=getDB(),up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
 VALUES (@rowId,'jprc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()`);
 const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jprc',n.id);up.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});if(old)updated++;else added++;}return{added,updated};});
 const counts=tx(rows),detailStats=persistJprcDetails(rows,verified);
 return {...counts,...detailStats,received:rows.length,normalized:rows.length,failed:failures,source:'jprc',sourceUrl:LIST_URL};
}
module.exports={parseJprcRows,parseJprcDetail,fetchJprcDetail,persistJprcDetails,syncJPRC,LIST_URL};
// Public-source connector regression coverage is in tests/jprc-sync.test.js.
