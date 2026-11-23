'use strict';
/**
 * Read-only connector for TED (Tenders Electronic Daily), the EU's official
 * public procurement notice service. Search API access to published notices
 * is anonymous; this connector never submits or modifies notices.
 */
const { getDB, uid } = require('../db');

const API_URL='https://api.ted.europa.eu/v3/notices/search';
const PAGE_SIZE=100;
const FIELDS=[
 'publication-number','publication-date','notice-title','buyer-name',
 'buyer-country','document-official-language-lot','document-official-language-part','classification-cpv','place-of-performance',
 'deadline-receipt-tender-date-lot','deadline-receipt-request-date-lot',
 'notice-type','procedure-type','estimated-value-proc','estimated-value-cur-proc',
 'document-url-lot','document-url-part','document-restricted-url-lot','document-restricted-url-part',
 'submission-url-lot'
];
const clean=(v,n=3000)=>String(v==null?'':v).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
function firstText(value){
 if(value==null)return '';
 if(typeof value==='string'||typeof value==='number')return clean(value,1200);
 if(Array.isArray(value)){for(const item of value){const text=firstText(item);if(text)return text;}return '';}
 if(typeof value==='object'){
  for(const lang of ['eng','en','fra','deu','nld','ell','ita','spa','por']){
   if(value[lang]!=null){const text=firstText(value[lang]);if(text)return text;}
  }
  for(const item of Object.values(value)){const text=firstText(item);if(text)return text;}
 }
 return '';
}
function flattenValues(value){
 if(value==null)return [];
 if(Array.isArray(value))return value.flatMap(flattenValues);
 if(typeof value==='object')return Object.values(value).flatMap(flattenValues);
 return [clean(value,500)];
}
function isoDate(value){
 const text=firstText(value);
 if(!text)return null;
 const d=new Date(text);
 return Number.isNaN(d.getTime())?(/^\d{4}-\d{2}-\d{2}/.test(text)?text.slice(0,10):null):d.toISOString();
}
function countryCode(value){
 const raw=firstText(value).toUpperCase();
 const map={AUT:'AT',BEL:'BE',BGR:'BG',HRV:'HR',CYP:'CY',CZE:'CZ',DNK:'DK',EST:'EE',FIN:'FI',FRA:'FR',DEU:'DE',GRC:'GR',HUN:'HU',IRL:'IE',ITA:'IT',LVA:'LV',LTU:'LT',LUX:'LU',MLT:'MT',NLD:'NL',POL:'PL',PRT:'PT',ROU:'RO',SVK:'SK',SVN:'SI',ESP:'ES',SWE:'SE',ISL:'IS',LIE:'LI',NOR:'NO',ALB:'AL',AND:'AD',ARM:'AM',AZE:'AZ',BIH:'BA',BLR:'BY',CHE:'CH',GBR:'GB',GEO:'GE',MDA:'MD',MCO:'MC',MNE:'ME',MKD:'MK',SMR:'SM',SRB:'RS',TUR:'TR',UKR:'UA',VAT:'VA',XKX:'XK'};
 if(/^[A-Z]{2}$/.test(raw))return raw;
 return map[raw]||'INT';
}
function safeOfficialHttps(value){
  const raw=clean(value,2000);
  try{const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;return url.toString();}catch(_){return null;}
}
function officialPortalLinks(row){
 const collect=(key,label,access)=>flattenValues(row[key]).map(safeOfficialHttps).filter(Boolean).map(url=>({title:label,url,access}));
 const links=[
  ...collect('document-url-lot','Official procurement documents','public'),
  ...collect('document-url-part','Official procurement documents','public'),
  ...collect('document-restricted-url-lot','Restricted procurement documents','restricted'),
  ...collect('document-restricted-url-part','Restricted procurement documents','restricted')
 ];
 const seen=new Set();return links.filter(x=>{if(seen.has(x.url))return false;seen.add(x.url);return true;}).slice(0,20);
}
function tedLanguageCode(value){
 const raw=firstText(value).trim().toUpperCase();
 if(/^[A-Z]{2}$/.test(raw))return raw.toLowerCase();
 const map={"ENG":"en","DEU":"de","FRA":"fr","NLD":"nl","ELL":"el","ITA":"it","SPA":"es","POR":"pt","POL":"pl","CES":"cs","SLK":"sk","SLV":"sl","HRV":"hr","HUN":"hu","RON":"ro","BUL":"bg","DAN":"da","SWE":"sv","FIN":"fi","EST":"et","LAV":"lv","LIT":"lt","MLT":"mt","GLE":"ga"};
 return map[raw]||'en';
}
function noticeLinks(row,publicationNumber,language='en'){
 // Prefer the direct PDF representation returned by TED Search API.
 const returned=flattenValues(row && row.links).filter(value=>{
  try{
   const url=new URL(value);
   if(url.protocol!=='https:' || (url.hostname!=='ted.europa.eu'&&!url.hostname.endsWith('.ted.europa.eu')))return false;
   const parts=url.pathname.split('/').filter(Boolean);
   const index=parts.lastIndexOf('notice');
   return index>=0 && parts[index+1]===String(publicationNumber) && ['pdf','pdfs'].includes(String(parts[index+2]||'').toLowerCase());
  }catch(_){return false;}
 });
 const preferred=returned.find(value=>{
  try{
   const parts=new URL(value).pathname.split('/').filter(Boolean);
   const index=parts.lastIndexOf('notice');
   return index>0 && parts[index-1].toLowerCase()===String(language||'en').toLowerCase() && parts[index+2].toLowerCase()==='pdf';
  }catch(_){return false;}
 });
 const selected=preferred||returned[0]||('https://ted.europa.eu/'+language+'/notice/'+encodeURIComponent(publicationNumber)+'/pdf');
 return [{title:'Official TED notice PDF',url:selected,format:'pdf'}];
}
function normalizeTEDNotice(row,now=Date.now()){
 if(!row||typeof row!=='object')return null;
 const publicationNumber=clean(row['publication-number'],100);
 const title=firstText(row['notice-title']);
 if(!publicationNumber||!title)return null;
 const published=isoDate(row['publication-date']);
 const deadlines=[...flattenValues(row['deadline-receipt-tender-date-lot']),...flattenValues(row['deadline-receipt-request-date-lot'])]
  .map(isoDate).filter(Boolean).sort();
 const closing=deadlines[0]||null;
 const cpv=flattenValues(row['classification-cpv']).filter(Boolean).slice(0,12).join(', ');
 const buyer=firstText(row['buyer-name'])||'EU public contracting authority';
 const buyerCountry=countryCode(row['buyer-country']);
 const performance=flattenValues(row['place-of-performance']).filter(Boolean).slice(0,12).join(' · ');
 const officialLanguage=tedLanguageCode(row['document-official-language-lot']||row['document-official-language-part']);
 const type=firstText(row['notice-type']);
 const procedure=firstText(row['procedure-type']);
 const value=firstText(row['estimated-value-proc']);
 const currency=firstText(row['estimated-value-cur-proc']);
 const expired=closing ? new Date(closing).getTime()<now : false;
 const docs=noticeLinks(row,publicationNumber,officialLanguage);
 const procurementDocuments=officialPortalLinks(row);
 const submissionUrls=flattenValues(row['submission-url-lot']).map(safeOfficialHttps).filter(Boolean);
 const sourceUrl='https://ted.europa.eu/'+officialLanguage+'/notice/-/detail/'+encodeURIComponent(publicationNumber);
 const details={
  source:'TED – Tenders Electronic Daily',
  publicationNumber,publicationDate:published,officialLanguage,noticeType:type,procedureType:procedure,
  buyerName:buyer,buyerCountry,classificationCPV:cpv||null,
  placeOfPerformance:performance||null,estimatedValue:value||null,
  estimatedValueCurrency:currency||null,
  deadlines:deadlines,
  officialLinks:docs,
  procurementDocuments,
  submissionUrl:submissionUrls[0]||null
 };
 return {
  id:publicationNumber,title,authority:buyer,country:buyerCountry,
  sector:cpv||null,tenderNumber:publicationNumber,
  summary:[type,procedure,performance].filter(Boolean).join(' · ')||null,
  publishedAt:published,closingAt:closing,sourceUrl,applicationUrl:null,
  status:expired?'closed':'open',language:officialLanguage,details,documents:docs
 };
}
async function postSearch(body,{timeoutMs=60000,attempts=4}={}){
 let lastError;
 for(let attempt=1;attempt<=attempts;attempt++){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetch(API_URL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'MMC-TenderWise/1.0'},body:JSON.stringify(body),signal:controller.signal});
   if(!response.ok){
    const retryable=response.status===408||response.status===425||response.status===429||response.status>=500;
    const error=new Error('TED Search API returned HTTP '+response.status);
    if(!retryable||attempt===attempts)throw error;
    const retry=response.headers.get('retry-after');
    const wait=retry&&/^\d+$/.test(retry)?Math.min(30000,Number(retry)*1000):Math.min(20000,1500*2**(attempt-1));
    await new Promise(resolve=>setTimeout(resolve,wait));continue;
   }
   return await response.json();
  }catch(err){
   lastError=err;
   const retryable=err.name==='AbortError'||/fetch failed|network|socket|timeout/i.test(err.message||'');
   if(!retryable||attempt===attempts)throw err;
   await new Promise(resolve=>setTimeout(resolve,Math.min(20000,1500*2**(attempt-1))));
  }finally{clearTimeout(timer);}
 }
 throw lastError||new Error('TED Search API request failed');
}
function saveTEDRows(notices){
 const db=getDB();
 const upsert=db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
 VALUES (@rowId,'ted',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
 ON CONFLICT(source_key,external_id) DO UPDATE SET
 title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,
 tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
 closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,
 status=excluded.status,language=excluded.language,details_json=excluded.details_json,updated_at=unixepoch()`);
 const addDoc=db.prepare(`INSERT INTO tender_opportunity_public_documents
 (id,opportunity_id,label,document_url,availability)
 VALUES (@id,@opportunityId,@label,@url,'public-source-link')
 ON CONFLICT(opportunity_id,document_url) DO UPDATE SET label=excluded.label`);
 const tx=db.transaction(items=>{
  let added=0,updated=0,documents=0;
  for(const item of items){
   const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('ted',item.id);
   const rowId=old?old.id:uid('opp_');
   upsert.run({rowId,externalId:item.id,title:item.title,authority:item.authority,country:item.country,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status,language:item.language,detailsJson:JSON.stringify(item.details||{})});
   for(const doc of item.documents||[]){
    const host=new URL(doc.url).hostname.toLowerCase();
    if(host!=='ted.europa.eu'&&!host.endsWith('.ted.europa.eu')&&host!=='api.ted.europa.eu')continue;
    addDoc.run({id:uid('tdoc_'),opportunityId:rowId,label:doc.title||'TED notice document',url:doc.url});documents++;
   }
   if(old)updated++;else added++;
  }
  return {added,updated,documents};
 });
 return tx(notices);
}
async function syncTED({days=45,pages=5,rows=100}={}){
 const since=new Date(Date.now()-Math.max(1,days)*86400000).toISOString().slice(0,10).replace(/-/g,'');
 const pageSize=Math.min(250,Math.max(1,rows));
 const query='publication-date>='+since+' AND notice-type=cn-standard SORT BY publication-date DESC';
 let token=null,received=0,pagesFetched=0;
 const mappedById=new Map();
 for(let page=0;page<Math.min(20,Math.max(1,pages));page++){
  const body={query,fields:FIELDS,limit:pageSize,scope:'ALL',paginationMode:'ITERATION',onlyLatestVersions:true};
  if(token)body.iterationNextToken=token;
  const payload=await postSearch(body);
  const values=Array.isArray(payload.notices)?payload.notices:[];
  received+=values.length;pagesFetched++;
  for(const raw of values){const item=normalizeTEDNotice(raw);if(item)mappedById.set(item.id,item);}
  token=payload.iterationNextToken||null;
  if(!token||values.length<pageSize)break;
 }
 const mapped=[...mappedById.values()];
 const counts=saveTEDRows(mapped);
 return {...counts,received,normalized:mapped.length,source:'ted',pages:pagesFetched,query};
}
module.exports={FIELDS,firstText,tedLanguageCode,normalizeTEDNotice,noticeLinks,syncTED};
,'i').test(url.pathname);
  }catch(_){return false;}
 });
 const preferred=returned.find(value=>{
  try{return new URL(value).pathname.split('/').slice(-3,-2)[0].toLowerCase()===language;}catch(_){return false;}
 });
 const selected=preferred||returned[0]||('https://ted.europa.eu/'+language+'/notice/'+encodeURIComponent(publicationNumber)+'/pdf');
 return [{title:'Official TED notice PDF',url:selected,format:'pdf'}];
}
function normalizeTEDNotice(row,now=Date.now()){
 if(!row||typeof row!=='object')return null;
 const publicationNumber=clean(row['publication-number'],100);
 const title=firstText(row['notice-title']);
 if(!publicationNumber||!title)return null;
 const published=isoDate(row['publication-date']);
 const deadlines=[...flattenValues(row['deadline-receipt-tender-date-lot']),...flattenValues(row['deadline-receipt-request-date-lot'])]
  .map(isoDate).filter(Boolean).sort();
 const closing=deadlines[0]||null;
 const cpv=flattenValues(row['classification-cpv']).filter(Boolean).slice(0,12).join(', ');
 const buyer=firstText(row['buyer-name'])||'EU public contracting authority';
 const buyerCountry=countryCode(row['buyer-country']);
 const performance=flattenValues(row['place-of-performance']).filter(Boolean).slice(0,12).join(' · ');
 const officialLanguage=tedLanguageCode(row['document-official-language-lot']||row['document-official-language-part']);
 const type=firstText(row['notice-type']);
 const procedure=firstText(row['procedure-type']);
 const value=firstText(row['estimated-value-proc']);
 const currency=firstText(row['estimated-value-cur-proc']);
 const expired=closing ? new Date(closing).getTime()<now : false;
 const docs=noticeLinks(row,publicationNumber,officialLanguage);
 const procurementDocuments=officialPortalLinks(row);
 const submissionUrls=flattenValues(row['submission-url-lot']).map(safeOfficialHttps).filter(Boolean);
 const sourceUrl='https://ted.europa.eu/'+officialLanguage+'/notice/-/detail/'+encodeURIComponent(publicationNumber);
 const details={
  source:'TED – Tenders Electronic Daily',
  publicationNumber,publicationDate:published,officialLanguage,noticeType:type,procedureType:procedure,
  buyerName:buyer,buyerCountry,classificationCPV:cpv||null,
  placeOfPerformance:performance||null,estimatedValue:value||null,
  estimatedValueCurrency:currency||null,
  deadlines:deadlines,
  officialLinks:docs,
  procurementDocuments,
  submissionUrl:submissionUrls[0]||null
 };
 return {
  id:publicationNumber,title,authority:buyer,country:buyerCountry,
  sector:cpv||null,tenderNumber:publicationNumber,
  summary:[type,procedure,performance].filter(Boolean).join(' · ')||null,
  publishedAt:published,closingAt:closing,sourceUrl,applicationUrl:null,
  status:expired?'closed':'open',language:officialLanguage,details,documents:docs
 };
}
async function postSearch(body,{timeoutMs=60000,attempts=4}={}){
 let lastError;
 for(let attempt=1;attempt<=attempts;attempt++){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetch(API_URL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'MMC-TenderWise/1.0'},body:JSON.stringify(body),signal:controller.signal});
   if(!response.ok){
    const retryable=response.status===408||response.status===425||response.status===429||response.status>=500;
    const error=new Error('TED Search API returned HTTP '+response.status);
    if(!retryable||attempt===attempts)throw error;
    const retry=response.headers.get('retry-after');
    const wait=retry&&/^\d+$/.test(retry)?Math.min(30000,Number(retry)*1000):Math.min(20000,1500*2**(attempt-1));
    await new Promise(resolve=>setTimeout(resolve,wait));continue;
   }
   return await response.json();
  }catch(err){
   lastError=err;
   const retryable=err.name==='AbortError'||/fetch failed|network|socket|timeout/i.test(err.message||'');
   if(!retryable||attempt===attempts)throw err;
   await new Promise(resolve=>setTimeout(resolve,Math.min(20000,1500*2**(attempt-1))));
  }finally{clearTimeout(timer);}
 }
 throw lastError||new Error('TED Search API request failed');
}
function saveTEDRows(notices){
 const db=getDB();
 const upsert=db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
 VALUES (@rowId,'ted',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
 ON CONFLICT(source_key,external_id) DO UPDATE SET
 title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,
 tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
 closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,
 status=excluded.status,language=excluded.language,details_json=excluded.details_json,updated_at=unixepoch()`);
 const addDoc=db.prepare(`INSERT INTO tender_opportunity_public_documents
 (id,opportunity_id,label,document_url,availability)
 VALUES (@id,@opportunityId,@label,@url,'public-source-link')
 ON CONFLICT(opportunity_id,document_url) DO UPDATE SET label=excluded.label`);
 const tx=db.transaction(items=>{
  let added=0,updated=0,documents=0;
  for(const item of items){
   const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('ted',item.id);
   const rowId=old?old.id:uid('opp_');
   upsert.run({rowId,externalId:item.id,title:item.title,authority:item.authority,country:item.country,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status,language:item.language,detailsJson:JSON.stringify(item.details||{})});
   for(const doc of item.documents||[]){
    const host=new URL(doc.url).hostname.toLowerCase();
    if(host!=='ted.europa.eu'&&!host.endsWith('.ted.europa.eu')&&host!=='api.ted.europa.eu')continue;
    addDoc.run({id:uid('tdoc_'),opportunityId:rowId,label:doc.title||'TED notice document',url:doc.url});documents++;
   }
   if(old)updated++;else added++;
  }
  return {added,updated,documents};
 });
 return tx(notices);
}
async function syncTED({days=45,pages=5,rows=100}={}){
 const since=new Date(Date.now()-Math.max(1,days)*86400000).toISOString().slice(0,10).replace(/-/g,'');
 const pageSize=Math.min(250,Math.max(1,rows));
 const query='publication-date>='+since+' AND notice-type=cn-standard SORT BY publication-date DESC';
 let token=null,received=0,pagesFetched=0;
 const mappedById=new Map();
 for(let page=0;page<Math.min(20,Math.max(1,pages));page++){
  const body={query,fields:FIELDS,limit:pageSize,scope:'ALL',paginationMode:'ITERATION',onlyLatestVersions:true};
  if(token)body.iterationNextToken=token;
  const payload=await postSearch(body);
  const values=Array.isArray(payload.notices)?payload.notices:[];
  received+=values.length;pagesFetched++;
  for(const raw of values){const item=normalizeTEDNotice(raw);if(item)mappedById.set(item.id,item);}
  token=payload.iterationNextToken||null;
  if(!token||values.length<pageSize)break;
 }
 const mapped=[...mappedById.values()];
 const counts=saveTEDRows(mapped);
 return {...counts,received,normalized:mapped.length,source:'ted',pages:pagesFetched,query};
}
module.exports={FIELDS,firstText,tedLanguageCode,normalizeTEDNotice,noticeLinks,syncTED};
