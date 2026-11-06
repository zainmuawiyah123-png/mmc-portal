'use strict';
/** Public, read-only Bahrain Tender Board importer. No supplier login or paid-document access. */
const {getDB,uid}=require('../db');
const LIST_URL='https://www.tenderboard.gov.bh/Ar/Tenders/PublicTenders/';
const HOSTS=new Set(['www.tenderboard.gov.bh','tenderboard.gov.bh']);
const MONTHS={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12,'يناير':1,'فبراير':2,'مارس':3,'أبريل':4,'ابريل':4,'مايو':5,'يونيو':6,'يوليو':7,'أغسطس':8,'اغسطس':8,'سبتمبر':9,'أكتوبر':10,'اكتوبر':10,'نوفمبر':11,'ديسمبر':12};
const clean=(v,n=3000)=>String(v==null?'':v).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
function decode(v){return String(v||'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(+x));}
function plain(html){return clean(decode(String(html||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<br\b[^>]*>/gi,' ').replace(/<\/(?:td|th|div|p|li|a)>/gi,' ').replace(/<[^>]+>/g,' ')));}
function dateISO(value){
 const s=clean(value,60).replace(/،/g,',');
 let m=s.match(/^(\d{1,2})\s*[,/-]?\s*([A-Za-z]+|[\u0600-\u06ff]+)\s*[,/-]?\s*(\d{4})$/);
 if(m){const d=+m[1],mo=MONTHS[m[2].toLowerCase()],y=+m[3];if(!mo)return null;const x=new Date(Date.UTC(y,mo-1,d));return x.getUTCFullYear()===y&&x.getUTCMonth()===mo-1&&x.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
 m=s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);if(!m)return null;
 const d=+m[1],mo=+m[2],y=+m[3],x=new Date(Date.UTC(y,mo-1,d));
 return x.getUTCFullYear()===y&&x.getUTCMonth()===mo-1&&x.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;
}
function extractTenderReference(value){
 const s=clean(value,1000);
 const patterns=[/^(Nuwab\s+Public\s+\d+\s*\/\s*\d{4})\s*/i,/^([A-Z0-9]+(?:[/-][A-Z0-9]+){1,7})\s+/i,/^([A-Z0-9]{5,})\s+/i];
 for(const re of patterns){const m=s.match(re);if(m&&/\d/.test(m[1]))return{number:clean(m[1],180).replace(/\s*\/\s*/g,'/'),title:clean(s.slice(m[0].length),1000)};}
 const compact=/^((?:TRA\/INTERNAL\/RFP\/\d{4}\/\d+|IN-RFP-[A-Z0-9-]+-\d{4}|PT\/[A-Z0-9/]+\/\d{4}\/\d+|[A-Z]{2,}[A-Z0-9]*\d{6,}|[A-Z0-9]+\/\d{4}\/BTB))(.*)$/i.exec(s);
 if(compact&&compact[2]&&/[A-Za-z\u0600-\u06ff]/.test(compact[2]))return{number:compact[1],title:clean(compact[2],1000)};
 return null;
}
function extractRowLink(html){
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){try{const u=new URL(decode(m[1]),LIST_URL);if(u.protocol==='https:'&&HOSTS.has(u.hostname))return u.toString();}catch(_){}}
 return LIST_URL;
}
function parseBahrainRows(html,today){
 const todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bahrain'}).format(new Date()),rows=[],seen=new Set();
 for(const m of String(html||'').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const rowHtml=m[1],cells=[...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>x[1]);
  if(cells.length<7)continue;
  const v=cells.map(plain),ref=extractTenderReference(v[1]||'');
  if(!ref||!ref.title||!v[3])continue;
  if(seen.has(ref.number))continue;
  const publishedAt=dateISO(v[4]),purchaseBefore=dateISO(v[5]),closingAt=dateISO(v[6]),detailUrl=extractRowLink(rowHtml);
  const tenderType=clean(v[2],80),authority=clean(v[3],240);
  const details={tenderType:tenderType||null,purchaseBefore,officialDetailUrl:detailUrl===LIST_URL?null:detailUrl,officialListUrl:LIST_URL,documentsDownloadable:false,documentsNote:'لم يتم فهرسة وثائق لهذا الإعلان؛ يجب اتباع إجراءات مجلس المناقصات الرسمية لشراء الوثائق أو الوصول إليها.'};
  const summary=[tenderType?'نوع المناقصة: '+tenderType:null,publishedAt?'تاريخ النشر: '+publishedAt:null,purchaseBefore?'آخر موعد لشراء الوثائق: '+purchaseBefore:null,closingAt?'تاريخ الإغلاق: '+closingAt:null].filter(Boolean).join(' | ');
  rows.push({id:ref.number,title:ref.title.slice(0,300),authority,country:'BH',sector:null,tenderNumber:ref.number,summary,publishedAt,closingAt,sourceUrl:detailUrl,applicationUrl:null,status:closingAt&&closingAt<todayISO?'closed':'open',language:'en',details});
  seen.add(ref.number);
 }
 return rows;
}
async function fetchPublicPage(){
 const u=new URL(LIST_URL);if(u.protocol!=='https:'||!HOSTS.has(u.hostname))throw new Error('Blocked non-Tender-Board source URL');
 const r=await fetch(u,{headers:{Accept:'text/html','User-Agent':'MMC-Tender-Directory/1.0 (public procurement index)'},signal:AbortSignal.timeout(20000),redirect:'manual'});
 if(r.status>=300&&r.status<400)throw new Error('Bahrain Tender Board redirected the request; refusing an unverified redirect.');
 if(!r.ok)throw new Error('Bahrain Tender Board returned HTTP '+r.status);
 const html=await r.text();if(!/<table\b/i.test(html)||!/Closing Date|Purchase Before|تاريخ الاغلاق|تاريخ الإغلاق|آخر موعد لشراء وثائق المناقصة/i.test(html))throw new Error('Bahrain Tender Board response did not contain the expected public tender table; no records changed.');
 return html;
}
function persistBahrain(rows){
 const db=getDB();
 const up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language) VALUES (@rowId,'bahrain-tender-board',@externalId,@title,@authority,'BH',@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,NULL,@status,@language) ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()`);
 const detailUp=db.prepare('INSERT INTO tender_opportunity_details (opportunity_id,details_json,verified_at) VALUES (?,?,unixepoch()) ON CONFLICT(opportunity_id) DO UPDATE SET details_json=excluded.details_json,verified_at=unixepoch()');
 const tx=db.transaction(items=>{let added=0,updated=0;for(const row of items){const old=db.prepare("SELECT id FROM tender_opportunities WHERE source_key='bahrain-tender-board' AND external_id=?").get(row.id),id=old?old.id:uid('opp_');up.run({rowId:id,externalId:row.id,title:row.title,authority:row.authority,sector:row.sector,tenderNumber:row.tenderNumber,summary:row.summary,publishedAt:row.publishedAt,closingAt:row.closingAt,sourceUrl:row.sourceUrl,status:row.status,language:row.language});detailUp.run(id,JSON.stringify(row.details));if(old)updated++;else added++;}return{added,updated};});
 return tx(rows);
}
async function syncBahrain(){
 const html=await fetchPublicPage(),rows=parseBahrainRows(html);
 if(!rows.length)throw new Error('Bahrain Tender Board page loaded, but no verifiable tender rows were parsed; no records changed.');
 return{...persistBahrain(rows),received:rows.length,normalized:rows.length,source:'bahrain-tender-board',sourceUrl:LIST_URL};
}
module.exports={LIST_URL,parseBahrainRows,dateISO,extractTenderReference,persistBahrain,syncBahrain};
