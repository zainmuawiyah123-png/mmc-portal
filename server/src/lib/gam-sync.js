'use strict';
/** Read-only importer for Greater Amman Municipality public tender announcements. */
const LIST_URL='https://media.ammancity.gov.jo/AR/List/اعلانات_العطاءات', ORIGIN='https://media.ammancity.gov.jo';
const clean=s=>String(s||'').replace(/<script[\\s\\S]*?<\\/script>/gi,' ').replace(/<style[\\s\\S]*?<\\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\\d+);/g,(_,x)=>String.fromCodePoint(+x)).replace(/\\s+/g,' ').trim();
function dateISO(v){const m=String(v||'').match(/(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{4})/);if(!m)return null;const d=+m[1],mo=+m[2],y=+m[3],dt=new Date(Date.UTC(y,mo-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
function extractDetailUrls(html){
 const urls=new Set([LIST_URL]);
 for(const m of String(html||'').matchAll(/<a\\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){
  try{const u=new URL(m[1],LIST_URL);if(u.origin===ORIGIN&&/\\/AR\\/ListDetails\\//i.test(u.pathname))urls.add(u.toString());}catch(_){}
 }
 return [...urls].filter(x=>x!==LIST_URL);
}
function parseGAMRows(html,today,detailUrl){
 const out=[],seen=new Set(),source=String(html||''),todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
 for(const tr of source.matchAll(/<tr\\b[\\s\\S]*?<\\/tr>/gi)){
  const cells=[...tr[0].matchAll(/<t[dh]\\b[^>]*>([\\s\\S]*?)<\\/t[dh]>/gi)].map(m=>clean(m[1]));
  if(cells.length<4)continue;
  const number=(cells.find(x=>/^\\d{1,4}\\s*\\/\\s*\\d{1,2}\\s*\\/\\s*202\\d$/.test(x))||cells.find(x=>/^\\d{1,4}\\s*\\/\\s*202\\d$/.test(x))||'').replace(/\\s+/g,'');
  if(!number)continue;
  const title=cells.find(x=>x.length>12&&!/^\\d/.test(x)&&!/(?:دينار|مجانا|مجانا|%|كفالة|مؤهلات|آخر موعد)/.test(x))||cells[1]||'';
  if(!title)continue;
  const dateCells=cells.map(dateISO).filter(Boolean);
  const closingAt=dateCells.length?dateCells[dateCells.length-1]:null;
  const id=number+'|'+(detailUrl||'');if(seen.has(id))continue;seen.add(id);
  out.push({id,title:title.slice(0,300),authority:'أمانة عمّان الكبرى / Greater Amman Municipality',country:'JO',
   sector:/أشغال|طرق|أدراج|خرسانة|إنشاء|صيانة|تأهيل|مياه|صرف صحي|حفريات/i.test(title)?'أعمال مدنية وإنشائية':null,
   tenderNumber:number,summary:'إعلان من بوابة العطاءات الرسمية لأمانة عمّان الكبرى. راجع الإعلان الأصلي للتحقق من كفالة الدخول وثمن النسخة ومؤهلات المقاول ومواعيد البيع والاستفسارات والإيداع.',
   publishedAt:null,closingAt,sourceUrl:detailUrl||LIST_URL,applicationUrl:null,status:closingAt&&closingAt<todayISO?'closed':'open',language:'ar'});
 }
 return out;
}
async function getPage(url,signal){const r=await fetch(url,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal});if(!r.ok)throw new Error('GAM returned HTTP '+r.status+' for '+url);return r.text();}
async function syncGAM(){
 const {getDB,uid}=require('../db'),ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),45000);
 try{
  const html=await getPage(LIST_URL,ctl.signal),urls=extractDetailUrls(html),pages=[];
  for(const url of urls.slice(0,30)){try{pages.push({url,html:await getPage(url,ctl.signal)});}catch(err){console.warn('[GAM] detail page skipped:',err.message);}}
  const rows=pages.flatMap(p=>parseGAMRows(p.html,undefined,p.url));
  if(!rows.length)throw new Error('GAM listing loaded but no recognizable tender table rows were found; no records changed.');
  const db=getDB(),up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
   VALUES (@rowId,'gam',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
   ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()`);
  const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('gam',n.id);up.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});if(old)updated++;else added++;}return{added,updated};});
  return{...tx(rows),received:rows.length,normalized:rows.length,source:'gam',sourceUrl:LIST_URL,detailPages:pages.length};
 }finally{clearTimeout(timer);}
}
module.exports={parseGAMRows,extractDetailUrls,syncGAM,LIST_URL};
