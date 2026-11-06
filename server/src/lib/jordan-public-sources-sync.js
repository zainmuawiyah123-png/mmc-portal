'use strict';
/**
 * Read-only connectors for official Jordanian tender notice pages.
 * Only public notice metadata is imported; no logins, bid submissions or paywalls are bypassed.
 */
const {getDB,uid}=require('../db');
const SOURCES=[
 {key:'gam',name:'أمانة عمّان الكبرى',url:'https://gamtenders.gov.jo/adlocaltenders.aspx',country:'JO',authority:'أمانة عمّان الكبرى'},
 {key:'jpmc',name:'شركة مناجم الفوسفات الأردنية',url:'https://www.jpmc.com.jo/ar/tender',country:'JO',authority:'شركة مناجم الفوسفات الأردنية'},
 {key:'nepco',name:'شركة الكهرباء الوطنية',url:'https://www.nepco.com.jo/Tenders.aspx',country:'JO',authority:'شركة الكهرباء الوطنية'},
 {key:'jepco',name:'شركة الكهرباء الأردنية',url:'https://www.jepco.com.jo/ar/Home/عرض-المناقصات-الحالية',country:'JO',authority:'شركة الكهرباء الأردنية'},
 {key:'sepco',name:'شركة السمرا لتوليد الكهرباء',url:'https://sepco.com.jo/en/tenders/1',country:'JO',authority:'شركة السمرا لتوليد الكهرباء'},
 {key:'jprc',name:'مصفاة البترول الأردنية',url:'https://www.jopetrol.com.jo/ar/modules/tenders',country:'JO',authority:'مصفاة البترول الأردنية'},
 {key:'jppmc',name:'شركة تسويق المنتجات البترولية الأردنية',url:'https://www.jppmc.jo/en/Bids',country:'JO',authority:'شركة تسويق المنتجات البترولية الأردنية'},
 {key:'jordan_bromine',name:'شركة البرومين الأردنية',url:'https://www.jordanbromine.com/tenders/',country:'JO',authority:'شركة البرومين الأردنية'},
 {key:'memr',name:'وزارة الطاقة والثروة المعدنية',url:'https://www.memr.gov.jo/AR/Modules/Tenders',country:'JO',authority:'وزارة الطاقة والثروة المعدنية'},
 {key:'mwi',name:'وزارة المياه والري',url:'https://mwi.gov.jo/AR/Modules/tenders',country:'JO',authority:'وزارة المياه والري'},
 {key:'emrc',name:'هيئة تنظيم قطاع الطاقة والمعادن',url:'https://emrc.gov.jo/Ar/Modules/Tenders',country:'JO',authority:'هيئة تنظيم قطاع الطاقة والمعادن'},
 {key:'unicef_jo',name:'UNICEF Jordan',url:'https://www.unicef.org/jordan/supply-and-procurement',country:'JO',authority:'UNICEF Jordan'},
 {key:'unhcr_jo',name:'UNHCR Jordan',url:'https://www.unhcr.org/jo/get-involved/become-supplier',country:'JO',authority:'UNHCR Jordan'}
];
const decode=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g,' ').trim();
const dateISO=s=>{
 const v=String(s||'');
 let m=v.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
 if(m)return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
 m=v.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
 if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
 m=v.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[,]?\s+(\d{4})/i);
 if(m){const n=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].slice(0,3).toLowerCase())+1;return m[3]+'-'+String(n).padStart(2,'0')+'-'+m[1].padStart(2,'0');}
 return null;
};
function allowedUrl(raw,base){
 try{const u=new URL(raw,base),b=new URL(base);return u.protocol==='https:'&&(u.hostname===b.hostname||u.hostname.endsWith('.'+b.hostname))?u.toString():null;}catch(_){return null;}
}
function candidateBlocks(html){
 const out=[];
 for(const m of String(html||'').matchAll(/<tr\b[\s\S]*?<\/tr>/gi))out.push(m[0]);
 for(const m of String(html||'').matchAll(/<(?:article|li)\b[\s\S]*?<\/(?:article|li)>/gi))out.push(m[0]);
 return out;
}
function parseSource(html,source,today=new Date().toISOString().slice(0,10)){
 const blocks=candidateBlocks(html),items=[],seen=new Set();
 const consume=(block,baseUrl)=>{
  const plain=decode(block);if(plain.length<18||plain.length>12000)return;
  const links=[...String(block).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  if(!links.length)return;
  const relevant=source.key==='unicef_jo'?/(request for proposal|invitation to bid|tender|procurement|expression of interest|lrps|rfp)/i.test(plain):/(tender|مناقصة|عطاء|مزايدة|مناقصات|عطاءات|bid|rfp|ifb|rfq)/i.test(plain);
  if(!relevant)return;
  const number=(plain.match(/(?:tender\s*(?:no\.?|#)?|عطاء\s*(?:رقم)?|مناقصة\s*(?:رقم)?|LRPS\s*)[:#№\s-]*([A-Z0-9][A-Z0-9\/-]{2,})/i)||[])[1]||null;
  const dateMatches=[...plain.matchAll(/(?:20\d{2}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]20\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[,]?\s+20\d{2})/gi)].map(m=>dateISO(m[0])).filter(Boolean);
  const closing=dateMatches.length?dateMatches[dateMatches.length-1]:null;
  const titleLink=links.map(x=>decode(x[2])).find(x=>x.length>8&&!/read more|المزيد|التفاصيل|download|اقرأ المزيد/i.test(x));
  const title=titleLink||plain.slice(0,220);
  if(!title||title.length<8)return;
  const link=links.map(x=>allowedUrl(x[1],baseUrl)).find(Boolean)||baseUrl;
  const external=number||link;
  if(seen.has(external))return;seen.add(external);
  const published=dateMatches.length>1?dateMatches[0]:null;
  items.push({id:source.key+':'+(number||BufferlessHash(link)),title:title.slice(0,300),authority:source.authority,country:'JO',sector:null,tenderNumber:number,summary:plain.slice(0,2500),publishedAt:published,closingAt:closing,sourceUrl:link,applicationUrl:null,status:closing&&closing<today?'closed':'open',language:/[\u0600-\u06FF]/.test(title)?'ar':'en'});
 };
 for(const block of blocks)consume(block,source.url);
 if(!items.length){
  const anchors=[...String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for(const a of anchors){
   const link=allowedUrl(a[1],source.url);if(!link||/[.](?:pdf|docx?|xlsx?|zip|rar|jpg|png)(?:$|[?#])/i.test(link))continue;
   const label=decode(a[2]);if(/^(?:download|تحميل|مرفق|attachment)$/i.test(label))continue;
   const at=a.index||0,context=decode(String(html||'').slice(Math.max(0,at-1800),Math.min(String(html||'').length,at+900)));
   if(!/tender|عطاء|مناقصة|bid|procurement|LRPS|RFP/i.test(label+' '+context))continue;
   const number=(context.match(/(?:tender\s*(?:no\.?|#)?|عطاء\s*(?:رقم)?|مناقصة\s*(?:رقم)?|LRPS\s*)[:#№\s-]*([A-Z0-9][A-Z0-9\/-]{2,})/i)||[])[1]||null;
   const title=label.length>8&&!/read more|اقرأ المزيد|التفاصيل|details/i.test(label)?label:
    ((context.match(/(?:اعلان|إعلان|طرح|عطاء|مناقصة|Tender)[^.!؟]{8,240}/i)||[])[0]||context.slice(-260));
   const id=source.key+':'+(number||BufferlessHash(link));if(seen.has(id))continue;seen.add(id);
   const dates=[...context.matchAll(/(?:20\d{2}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]20\d{2})/g)].map(m=>dateISO(m[0])).filter(Boolean);
   const closing=dates.length?dates[dates.length-1]:null;
   items.push({id,title:title.slice(0,300),authority:source.authority,country:'JO',sector:null,tenderNumber:number,summary:context.slice(-2500),publishedAt:dates.length>1?dates[0]:null,closingAt:closing,sourceUrl:link,applicationUrl:null,status:closing&&closing<today?'closed':'open',language:/[\u0600-\u06FF]/.test(title)?'ar':'en'});
  }
 }
 return items;
}
function BufferlessHash(s){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}
async function fetchHtml(url){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
 try{const r=await fetch(url,{headers:{Accept:'text/html,application/xhtml+xml','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);return await r.text();}
 finally{clearTimeout(timer);}
}
function extractNoticeDetails(html,source,item){
 const raw=String(html||''),plain=decode(raw).slice(0,20000);
 const pick=(patterns)=>{
  for(const re of patterns){const m=plain.match(re);if(m&&m[1])return m[1].trim().slice(0,2500);}
  return null;
 };
 const bond=pick([/(?:bid\s*bond|tender\s*bond|guarantee|كفالة\s*دخول\s*العطاء|كفالة\s*العطاء)\s*[:：-]?\s*([^|]{2,180})/i]);
 const fee=pick([/(?:document\s*fee|tender\s*fee|copy\s*price|رسوم\s*(?:وثائق|العطاء)|ثمن\s*(?:النسخة|الوثائق))\s*[:：-]?\s*([^|]{2,180})/i]);
 const qualification=pick([/(?:vendor\s*qualifications?|eligibility|pre[\s-]?qualification|شروط\s*التأهيل|المؤهلات\s*المطلوبة)\s*[:：-]?\s*([^|]{2,1200})/i]);
 const scope=pick([/(?:scope\s*of\s*work|description\s*of\s*works|نطاق\s*الأعمال|موضوع\s*العطاء)\s*[:：-]?\s*([^|]{2,1800})/i]);
 const method=pick([/(?:submission\s*method|how\s*to\s*submit|طريقة\s*التقديم)\s*[:：-]?\s*([^|]{2,600})/i]);
 const docs=[],seen=new Set();
 for(const a of raw.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  const label=decode(a[2]).slice(0,180),href=a[1];
  if(!label&&!/[.](?:pdf|docx?|xlsx?|zip|rar)(?:$|[?#])/i.test(href))continue;
  let u;try{u=new URL(href,item.sourceUrl);}catch(_){continue;}
  if(u.protocol!=='https:'||seen.has(u.toString()))continue;
  const looksDoc=/[.](?:pdf|docx?|xlsx?|zip|rar)(?:$|[?#])/i.test(u.pathname)||/(?:document|attachment|download|وثائق|مرفق|تحميل|كراسة|مواصفات|boq|bill of quantities)/i.test(label+' '+href);
  if(!looksDoc)continue;
  seen.add(u.toString());docs.push({label:label||'وثيقة العطاء',url:u.toString(),availability:'public-source-link'});
  if(docs.length>=30)break;
 }
 const title=pick([/(?:tender\s*(?:title|name)|عنوان\s*العطاء|موضوع\s*العطاء)\s*[:：-]?\s*([^|]{8,300})/i])||item.title;
 return {
  title,tenderNumber:item.tenderNumber||null,authority:source.authority,
  publishedAt:item.publishedAt||null,closingAt:item.closingAt||null,
  bondAmount:bond,bondType:bond?(/bank|بنك|مصرف/i.test(bond)?'كفالة بنكية':null):null,
  documentFee:fee,eligibility:qualification,scope,submissionMethod:method,
  description:plain,fullText:plain,detailSourceUrl:item.sourceUrl,
  extractionStatus:'public-page-extracted',documents:docs
 };
}
async function syncOne(source){
 const html=await fetchHtml(source.url),items=parseSource(html,source);
 if(!items.length)throw new Error('Official page loaded but no tender records were confidently parsed; no database changes were made.');
 const detailById=new Map();
 for(let i=0;i<items.length;i+=4){
  const batch=await Promise.all(items.slice(i,i+4).map(async item=>{
   if(!item.sourceUrl||item.sourceUrl===source.url)return {id:item.id,details:null};
   try{
    const detailHtml=await fetchHtml(item.sourceUrl);
    return {id:item.id,details:extractNoticeDetails(detailHtml,source,item)};
   }catch(_){return {id:item.id,details:null};}
  }));
  batch.forEach(x=>{if(x.details)detailById.set(x.id,x.details);});
 }
 const db=getDB(),upsert=db.prepare(\`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
 VALUES (@rowId,@sourceKey,@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=COALESCE(excluded.published_at,tender_opportunities.published_at),closing_at=COALESCE(excluded.closing_at,tender_opportunities.closing_at),source_url=excluded.source_url,status=excluded.status,language=excluded.language,details_json=COALESCE(excluded.details_json,tender_opportunities.details_json),updated_at=unixepoch()\`);
 const tx=db.transaction(rows=>{
  let added=0,updated=0,detailsReceived=0,documentsAdded=0;
  for(const n of rows){
   const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get(source.key,n.id);
   const opportunityId=old?old.id:uid('opp_'),detail=detailById.get(n.id)||null;
   upsert.run({rowId:opportunityId,sourceKey:source.key,externalId:n.id,title:detail?.title||n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language,detailsJson:detail?JSON.stringify(detail):null});
   if(detail){
    detailsReceived++;
    db.prepare('DELETE FROM tender_opportunity_public_documents WHERE opportunity_id=?').run(opportunityId);
    const ins=db.prepare('INSERT OR IGNORE INTO tender_opportunity_public_documents (id,opportunity_id,label,document_url,availability) VALUES (?,?,?,?,?)');
    detail.documents.forEach(doc=>{ins.run(uid('oppdoc_'),opportunityId,doc.label,doc.url,doc.availability);documentsAdded++;});
   }
   if(old)updated++;else added++;
  }
  return {added,updated,detailsReceived,documentsAdded};
 });
 return {...tx(items),received:items.length,normalized:items.length,source:source.key,sourceUrl:source.url};
}
async function syncJordanPublicSources(){
 const results={};
 for(let i=0;i<SOURCES.length;i+=4){
  const batch=await Promise.all(SOURCES.slice(i,i+4).map(async source=>{
   try{return [source.key,{ok:true,...await syncOne(source)}];}
   catch(e){return [source.key,{ok:false,error:(e.message||String(e)).slice(0,240)}];}
  }));
  for(const [key,result] of batch)results[key]=result;
 }
 return results;
}
module.exports={SOURCES,parseSource,syncOne,syncJordanPublicSources};
