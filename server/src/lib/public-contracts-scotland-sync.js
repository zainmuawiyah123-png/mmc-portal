'use strict';
/**
 * Read-only importer for Public Contracts Scotland's documented OCDS API.
 * Only public contract-notice releases are imported; supplier login, paid documents,
 * private Quick Quotes and bid submission are never automated.
 */
const { getDB, uid } = require('../db');

const API='https://api.publiccontractsscotland.gov.uk/v1/Notices';
const SOURCE='pcs';
const clean=(v,n=3000)=>String(v==null?'':v).replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim().slice(0,n);
const validDate=v=>{
  if(!v)return null;
  const d=new Date(v);
  return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
};
function releaseRows(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.releases))return payload.releases;
  if(Array.isArray(payload?.notices))return payload.notices;
  if(Array.isArray(payload?.data))return payload.data.flatMap(x=>Array.isArray(x?.releases)?x.releases:[x]);
  if(payload&&typeof payload==='object'&&payload.ocid&&payload.tender)return [payload];
  if(payload&&typeof payload==='object')return Object.values(payload).flatMap(x=>Array.isArray(x?.releases)?x.releases:(x&&x.ocid&&x.tender?[x]:[]));
  return [];
}
function normalizePCSNotice(release){
  if(!release||typeof release!=='object')return null;
  const tender=release.tender||{};
  const ocid=clean(release.ocid,180), releaseId=clean(release.id,180);
  const id=releaseId||ocid;
  const title=clean(tender.title||release.title,300);
  if(!id||!title)return null;
  const buyerId=clean(release.buyer?.id||tender procuringEntity?.id,180);
  const buyer=(release.parties||[]).find(p=>p.id===buyerId)||release.buyer||{};
  const authority=clean(buyer.name||release.buyer?.name||'Public Contracts Scotland contracting authority',200);
  const deadline=validDate(tender.tenderPeriod?.endDate||tender.enquiryPeriod?.endDate);
  const published=validDate(release.date||release.publishedDate||release.tender?.datePublished);
  const today=new Date().toISOString().slice(0,10);
  const tenderStatus=String(tender.status||'').toLowerCase();
  const status=['complete','cancelled','unsuccessful'].includes(tenderStatus)||(deadline&&deadline<today)?'closed':'open';
  const classifications=(tender.items||[]).flatMap(item=>item.classification?[item.classification]:[]).map(x=>clean(x.description||x.id,120)).filter(Boolean);
  const description=clean(tender.description||release.description,2200);
  const url='https://www.publiccontractsscotland.gov.uk/Search/Search_MainPage.aspx';
  const summary=[description,classifications.join(', ')].filter(Boolean).join(' · ')||'Public contract notice published through Public Contracts Scotland (OCDS).';
  return {id,ocid,title,authority,country:'GB',sector:classifications[0]||null,tenderNumber:clean(tender.id||releaseId||ocid,120)||id,summary,publishedAt:published,closingAt:deadline,sourceUrl:url,applicationUrl:null,status,language:'en'};
}
async function fetchPCSNotices({months=3,now=new Date()}={}){
  const monthCount=Math.min(6,Math.max(1,Number(months)||3)), found=[];
  for(let back=0;back<monthCount;back++){
    const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-back,1));
    const dateFrom=String(d.getUTCMonth()+1).padStart(2,'0')+'-'+d.getUTCFullYear();
    for(const noticeType of [2,5,102]){
      const url=new URL(API);
      url.searchParams.set('dateFrom',dateFrom);
      url.searchParams.set('noticeType',String(noticeType));
      url.searchParams.set('outputType','0');
      const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'MMC-Tender-Directory/1.0'},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('Public Contracts Scotland API returned HTTP '+response.status);
      const payload=await response.json();
      found.push(...releaseRows(payload));
    }
  }
  return found;
}
function persistPCS(rows){
  const mapped=rows.map(normalizePCSNotice).filter(Boolean);
  const db=getDB();
  const upsert=db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
    VALUES (@rowId,'pcs',@externalId,@title,@authority,'GB',@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,'en')
    ON CONFLICT(source_key,external_id) DO UPDATE SET
    title=excluded.title,authority=excluded.authority,country='GB',sector=excluded.sector,
    tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
    closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,
    status=excluded.status,language='en',updated_at=unixepoch()`);
  const tx=db.transaction(items=>{
    let added=0,updated=0;
    for(const item of items){
      const externalId=item.ocid?item.ocid+'::'+item.id:item.id;
      const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get(SOURCE,externalId);
      upsert.run({rowId:old?old.id:uid('opp_'),externalId,title:item.title,authority:item.authority,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status});
      if(old)updated++;else added++;
    }
    return {added,updated};
  });
  return {...tx(mapped),received:rows.length,normalized:mapped.length,source:SOURCE};
}
async function syncPCS(options={}){
  const rows=await fetchPCSNotices(options);
  if(rows.length===0)throw new Error('Public Contracts Scotland API returned no notice records; import stopped to avoid treating an empty response as a successful sync.');
  return persistPCS(rows);
}
module.exports={API,SOURCE,releaseRows,normalizePCSNotice,fetchPCSNotices,persistPCS,syncPCS};
