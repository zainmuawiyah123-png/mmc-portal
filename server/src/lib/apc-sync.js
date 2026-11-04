'use strict';
// Read-only APC public tender connector. Never accesses the authenticated supplier portal.
const {getDB,uid}=require('../db');
const LIST_URL='https://www.arabpotash.com/EN/Modules/Tenders';
const DETAIL_BASE='https://www.arabpotash.com/En/TendersDetails?PID=';
const HOSTS=new Set(['www.arabpotash.com','arabpotash.com']);
const clean=(v,n=3000)=>String(v==null?'':v).replace(/\s+/g,' ').trim().slice(0,n);
function decode(v){return String(v||'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));}
function plain(html){return decode(String(html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
function extractField(text,label,next){const re=new RegExp(label+'\\s*:?\\s*([\\s\\S]*?)(?=\\s*(?:'+next.join('|')+')\\s*:?|$)','i');const m=text.match(re);return m?clean(m[1],1500):null;}
function dateISO(v){const s=clean(v,40);let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/),d,mo,y;if(m){d=+m[1];mo=+m[2];y=+m[3];}else{m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;y=+m[1];mo=+m[2];d=+m[3];}const x=new Date(Date.UTC(y,mo-1,d));return x.getUTCFullYear()===y&&x.getUTCMonth()===mo-1&&x.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
async function fetchText(url){const u=new URL(url);if(!HOSTS.has(u.hostname)||u.protocol!=='https:')throw new Error('Blocked non-APC source URL');const r=await fetch(u,{headers:{'user-agent':'MMC-Tender-Directory/1.0 (public tender index)','accept':'text/html'},signal:AbortSignal.timeout(18000)});if(!r.ok)throw new Error('APC returned HTTP '+r.status);return r.text();}
function parseDetail(html,pid){
 const text=plain(html),title=extractField(text,'Tender title and number',['Purchase Date']);if(!title)throw new Error('APC detail page has no verifiable title');
 const purchase=extractField(text,'Purchase Date',['Closing date']),closing=extractField(text,'Closing date',['Copy Price']),fee=extractField(text,'Copy Price',['Bid Bond Value']),bond=extractField(text,'Bid Bond Value',['Vendor Qualifications']),qual=extractField(text,'Vendor Qualifications',['Remarks','Announcement','Tender Documents']),remarks=extractField(text,'Remarks',['Announcement','Tender Documents']);
 const docs=[],re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
 while((m=re.exec(html))){const label=plain(m[2]);if(!/announcement|document|وثائق|اعلان|إعلان/i.test(label))continue;try{const u=new URL(decode(m[1]),DETAIL_BASE+pid);if(u.protocol==='https:'&&HOSTS.has(u.hostname))docs.push({label:label||'Tender document',url:u.toString()});}catch(_){}}
 return {pid,title,purchase,closing,fee,bond,qual,remarks,detailUrl:DETAIL_BASE+encodeURIComponent(pid),docs};
}
function persist(items,failures){
 const db=getDB();
 const tx=db.transaction(()=>{
  let added=0,updated=0;
  for(const t of items){
   const closing=dateISO(t.closing),purchase=dateISO(t.purchase),today=new Date().toISOString().slice(0,10);
   const status=!closing?'draft':closing<today?'closed':'open';
   const summary=[
    purchase?'بدء شراء الوثائق: '+t.purchase:null,
    closing?'آخر موعد للتقديم: '+t.closing:null,
    t.fee?'رسوم نسخة العطاء: '+t.fee:null,
    t.bond?'كفالة العطاء: '+t.bond:null,
    t.qual?'شروط تأهيل المورد: '+t.qual:null,
    t.remarks?'ملاحظات الجهة: '+t.remarks:null
   ].filter(Boolean).join(' | ')||'تفاصيل العطاء منشورة من شركة البوتاس العربية؛ يرجى مراجعة التفاصيل داخل MMC.';
   const old=db.prepare("SELECT id FROM tender_opportunities WHERE source_key='arab-potash-company' AND external_id=?").get(t.pid);
   const id=old?old.id:uid('opp_');
   db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
    VALUES (@id,'arab-potash-company',@externalId,@title,'شركة البوتاس العربية','JO','الأعمال المدنية والصناعية',@number,@summary,@publishedAt,@closingAt,@url,NULL,@status,'en')
    ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()`).run({id,externalId:t.pid,title:t.title,number:(t.title.match(/(?:IFB|Tender|Prequalification)[^:]*\s*(?:No\.?|Number)?\s*:?\s*([\w/-]+)/i)||[])[1]||null,summary, publishedAt:purchase,closingAt:closing, url:t.detailUrl,status});
   const detail=JSON.stringify(t);
   db.prepare(`INSERT INTO tender_opportunity_details (opportunity_id,details_json,verified_at) VALUES (?,?,unixepoch())
    ON CONFLICT(opportunity_id) DO UPDATE SET details_json=excluded.details_json,verified_at=unixepoch()`).run(id,detail);
   const docInsert=db.prepare(`INSERT INTO tender_opportunity_documents (id,opportunity_id,label,document_url,availability)
    VALUES (?,?,?,?,'public') ON CONFLICT(opportunity_id,document_url) DO UPDATE SET label=excluded.label`);
   for(const d of t.docs){const crypto=require('crypto');docInsert.run('apcdoc_'+crypto.createHash('sha1').update(id+d.url).digest('hex'),id,d.label,d.url);}
   if(old)updated++;else added++;
  }
  return {added,updated};
 });
 const counts=tx();
 db.prepare(`INSERT INTO opportunity_sync_runs (id,source_key,started_at,finished_at,status,received,added,updated,duration_ms,error)
 VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uid('sync_'),'arab-potash-company',Math.floor(Date.now()/1000),Math.floor(Date.now()/1000),failures.length?'failed':'success',items.length+failures.length,counts.added,counts.updated,0,failures.length?failures.length+' detail page(s) failed: '+failures.slice(0,5).map(x=>x.id).join(', '):null);
 return {...counts,received:items.length+failures.length,normalized:items.length,failed:failures.length};
}
async function syncAPC(){
 const html=await fetchText(LIST_URL),ids=new Set();
 for(const m of html.matchAll(/(?:TendersDetails\?PID=|TendersDetails%3fPID%3d)(\d+)/gi))ids.add(m[1]);
 if(!ids.size)throw new Error('APC public listing returned no recognizable tender detail links; no records changed.');
 const items=[],failures=[];
 for(const pid of ids){try{items.push(parseDetail(await fetchText(DETAIL_BASE+encodeURIComponent(pid)),pid));}catch(e){failures.push({id:pid,message:e.message});}}
 if(!items.length)throw new Error('APC listing was reached but no tender detail could be verified; no records changed.');
 return {...persist(items,failures),source:'arab-potash-company',sourceUrl:LIST_URL};
}
module.exports={syncAPC,parseDetail,dateISO,LIST_URL};
