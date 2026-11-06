'use strict';
/** Public, read-only importer for Greater Amman Municipality tender announcements. */
const {getDB,uid}=require('../db');
const LIST_URL='https://media.ammancity.gov.jo/AR/List/اعلانات_العطاءات';
const ORIGIN='https://media.ammancity.gov.jo';
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(+x)).replace(/\s+/g,' ').trim();
function dateISO(v){
 const m=String(v||'').match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);if(!m)return null;
 const d=+m[1],mo=+m[2],y=+m[3],dt=new Date(Date.UTC(y,mo-1,d));
 return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;
}
function extractDetailUrls(html){
 const urls=new Set();
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){
  try{const u=new URL(m[1],LIST_URL);if(u.protocol==='https:'&&u.origin===ORIGIN&&/\/AR\/ListDetails\//i.test(u.pathname))urls.add(u.toString());}catch(_){}
 }
 return [...urls];
}
function parseGAMRows(html,today,detailUrl){
 const out=[],seen=new Set(),todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
 for(const tr of String(html||'').matchAll(/<tr\b[\s\S]*?<\/tr>/gi)){
  const cells=[...tr[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>clean(m[1]));
  if(cells.length<8)continue;
  const number=(cells[0]||'').replace(/\s+/g,'');
  if(!/^\d{1,4}\s*\/\s*\d{1,2}\s*\/\s*20\d{2}$/.test(cells[0]||''))continue;
  const title=cells[1];if(!title||title.length<4)continue;
  const lastSaleDate=dateISO(cells[5]),inquiryDeadline=dateISO(cells[6]),closingAt=dateISO(cells[7]);
  const id=number+'|'+(detailUrl||'');if(seen.has(id))continue;seen.add(id);
  const details={
   bidBond:cells[2]||null,documentFee:cells[3]||null,qualification:cells[4]||null,
   lastSaleDate,inquiryDeadline,closingDate:closingAt,purchaseDate:null,
   documentInstructions:'تعليمات الأمانة المنشورة: الحصول على الوثائق من المبنى الرئيسي، الطابق الثاني، دائرة العطاءات والمشتريات، مع إبراز المؤهلات والسجل التجاري ورخصة المهن حسب شروط الإعلان. كما تتيح الأمانة الاطلاع على الوثائق عبر gamtenders.gov.jo.',
   remarks:'يجب التحقق من أي ملاحق أو تعديلات لدى الجهة الطارحة قبل تقديم العرض.',
   officialDetailUrl:detailUrl||null,officialListUrl:LIST_URL,
   documentsDownloadable:false,documentsNote:'لم يظهر رابط تنزيل عام مباشر للوثائق في صفحة الإعلان؛ يخضع الحصول عليها لتعليمات الأمانة.'
  };
  const summary=[
   'كفالة الدخول: '+(details.bidBond||'غير مذكورة'),
   'ثمن النسخة: '+(details.documentFee||'غير مذكور'),
   'آخر موعد للبيع: '+(lastSaleDate||'غير مذكور'),
   'آخر موعد للاستفسارات: '+(inquiryDeadline||'غير مذكور'),
   'آخر موعد لإيداع العروض: '+(closingAt||'غير مذكور')
  ].join(' | ');
  out.push({id,title:title.slice(0,300),authority:'أمانة عمّان الكبرى / Greater Amman Municipality',country:'JO',
   sector:/أشغال|طرق|أدراج|خرسانة|إنشاء|صيانة|تأهيل|مياه|صرف صحي|حفريات/i.test(title)?'أعمال مدنية وإنشائية':null,
   tenderNumber:number,summary,publishedAt:null,closingAt,sourceUrl:LIST_URL,applicationUrl:null,
   status:closingAt&&closingAt<todayISO?'closed':'open',language:'ar',details});
 }
 return out;
}
async function getPage(url,signal){
 const u=new URL(url);if(u.protocol!=='https:'||u.origin!==ORIGIN)throw new Error('Blocked non-GAM source URL');
 const r=await fetch(u,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal});
 if(!r.ok)throw new Error('GAM returned HTTP '+r.status+' for '+url);return r.text();
}
async function syncGAM(){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),45000);
 try{
  const html=await getPage(LIST_URL,ctl.signal),urls=extractDetailUrls(html),pages=[];
  for(const url of urls.slice(0,50)){try{pages.push({url,html:await getPage(url,ctl.signal)});}catch(err){console.warn('[GAM] detail page skipped:',err.message);}}
  const rows=pages.flatMap(p=>parseGAMRows(p.html,undefined,p.url));
  if(!rows.length)throw new Error('GAM listing loaded but no recognizable tender table rows were found; no records changed.');
  const db=getDB();
  const up=db.prepare(\`INSERT INTO tender_opportunities
   (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
   VALUES (@rowId,'gam',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
   ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()\`);
  const detailUp=db.prepare(\`INSERT INTO tender_opportunity_details (opportunity_id,details_json,verified_at) VALUES (?,?,unixepoch())
   ON CONFLICT(opportunity_id) DO UPDATE SET details_json=excluded.details_json,verified_at=unixepoch()\`);
  const tx=db.transaction(items=>{
   let added=0,updated=0;
   for(const n of items){
    const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('gam',n.id),id=old?old.id:uid('opp_');
    up.run({rowId:id,externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});
    detailUp.run(id,JSON.stringify(n.details));if(old)updated++;else added++;
   }
   return{added,updated};
  });
  return{...tx(rows),received:rows.length,normalized:rows.length,source:'gam',sourceUrl:LIST_URL,detailPages:pages.length};
 }finally{clearTimeout(timer);}
}
module.exports={parseGAMRows,extractDetailUrls,syncGAM,LIST_URL,dateISO};
