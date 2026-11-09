'use strict';
/**
 * Read-only public UK procurement feeds.
 * Notices are normalized into MMC's contractor-facing tender directory.
 * The official source remains authoritative for amendments, eligibility and submission.
 */
const { getDB, uid } = require('../db');
const { isAllowedPublicDocumentUrl } = require('./public-tender-documents');

const FTS_URL = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const PCS_URL = 'https://api.publiccontractsscotland.gov.uk/v1/Notices';
const CF_URL = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const S2W_URL = 'https://api.sell2wales.gov.wales/v1/Notices';
const clean = (v, n=3000) => String(v == null ? '' : v).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const isoDate = v => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const pick = (obj, keys) => Object.fromEntries(keys.filter(k=>obj && obj[k]!==undefined && obj[k]!==null).map(k=>[k,obj[k]]));
function unpackPackages(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload.flatMap(unpackPackages);
  if (Array.isArray(payload.releases)) return payload.releases;
  if (Array.isArray(payload.packages)) return payload.packages.flatMap(unpackPackages);
  if (Array.isArray(payload.records)) return payload.records.flatMap(x => x && Array.isArray(x.releases) ? x.releases : (x && x.compiledRelease ? [x.compiledRelease] : []));
  if (Array.isArray(payload.results)) return payload.results.flatMap(unpackPackages);
  if (payload.package && Array.isArray(payload.package.releases)) return payload.package.releases;
  return [];
}
function normalizeOcdsRelease(release, sourceKey) {
  if (!release || typeof release !== 'object') return null;
  const tags = Array.isArray(release.tag) ? release.tag.map(x=>String(x).toLowerCase()) : (release.tag ? [String(release.tag).toLowerCase()] : []);
  if(tags.length && !tags.some(x=>['tender','tenderupdate'].includes(x))) return null;
  const tender = release.tender || {};
  const buyer = release.buyer || {};
  const title = clean(tender.title || release.title, 300);
  const externalId = clean(release.ocid || release.id, 160);
  if (!title || !externalId || !Object.keys(tender).length) return null;
  const end = isoDate(tender.tenderPeriod && tender.tenderPeriod.endDate);
  const today = new Date().toISOString().slice(0,10);
  const closingAt = end ? end.slice(0,10) : null;
  const rawStatus = String(tender.status || '').toLowerCase();
  const status = ['cancelled','withdrawn'].includes(rawStatus) ? 'cancelled' :
    (['complete','unsuccessful'].includes(rawStatus) || (closingAt && closingAt < today) ? 'closed' : 'open');
  const items = Array.isArray(tender.items) ? tender.items : [];
  const cpv = items.map(x => x && x.classification && x.classification.description).filter(Boolean).slice(0,6).join(' · ');
  const categories = items.map(x => x && x.classification && x.classification.id).filter(Boolean).slice(0,8).join(', ');
  const docs = [...(Array.isArray(tender.documents)?tender.documents:[]),...(Array.isArray(release.documents)?release.documents:[])].map((d,i)=>({
    id:clean(d.id || ('doc-'+i),120),
    title:clean(d.title || d.description || ('Tender document '+(i+1)),240),
    description:clean(d.description,800),
    documentType:clean(d.documentType,80),
    datePublished:isoDate(d.datePublished),
    url:clean(d.url,1500)
  })).filter(d=>d.url && isAllowedPublicDocumentUrl(sourceKey,d.url));
  let sourceUrl = sourceKey === 'findatender'
    ? (/^\\d{4,}-\\d{4,}$/.test(String(release.id||'')) ? 'https://www.find-tender.service.gov.uk/Notice/'+encodeURIComponent(String(release.id)) : 'https://www.find-tender.service.gov.uk/')
    : sourceKey === 'contractsfinder'
      ? 'https://www.contractsfinder.service.gov.uk/'
      : 'https://www.publiccontractsscotland.gov.uk/';
  const summary = [clean(tender.description,2200), categories, cpv].filter(Boolean).join(' · ').slice(0,3000);
  const details = {
    standard:'OCDS',
    ocid:externalId,
    releaseId:clean(release.id,160),
    releaseDate:isoDate(release.date || release.publishedDate),
    tag:clean(release.tag,80),
    buyer:pick(buyer,['name','id','address','contactPoint']),
    tender:pick(tender,['id','title','description','status','procurementMethod','procurementMethodDetails','mainProcurementCategory','additionalProcurementCategories','value','minValue','maxValue','tenderPeriod','contractPeriod','lots','items','documents','submissionMethod','submissionMethodDetails','submissionTerms','eligibilityCriteria','awardCriteria','awardCriteriaDetails','hasEnquiries','enquiryPeriod','amendment']),
    documents:docs
  };
  return {
    id:externalId,title,authority:clean(buyer.name || 'UK public contracting authority',200),
    country:'GB',sector:cpv || categories || null,tenderNumber:clean(tender.id || release.id || externalId,120),
    summary:summary || null,publishedAt:isoDate(release.date || release.publishedDate),
    closingAt:end,sourceUrl,applicationUrl:null,status,language:'en',
    details,documents:docs
  };
}
function saveRows(sourceKey, notices) {
  const db=getDB();
  const upsert=db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language,details_json)
    VALUES (@rowId,@sourceKey,@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language,@detailsJson)
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
      const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get(sourceKey,item.id);
      const rowId=old?old.id:uid('opp_');
      upsert.run({rowId,sourceKey,externalId:item.id,title:item.title,authority:item.authority,country:item.country,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status,language:item.language,detailsJson:JSON.stringify(item.details||{})});
      for(const doc of item.documents||[]){
        if(!isAllowedPublicDocumentUrl(sourceKey,doc.url)) continue;
        addDoc.run({id:uid('tdoc_'),opportunityId:rowId,label:doc.title||'Tender document',url:doc.url});
        documents++;
      }
      if(old)updated++;else added++;
    }
    return {added,updated,documents};
  });
  return tx(notices);
}
async function getJson(url) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),25000);
  try{
    const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'MMC-TenderWise/1.0 (public procurement data reader)'},signal:controller.signal});
    if(!response.ok)throw new Error('UK public feed returned HTTP '+response.status);
    return await response.json();
  }finally{clearTimeout(timer);}
}
function dedupeLatest(releases,sourceKey){
  const byId=new Map();
  for(const release of releases){
    const row=normalizeOcdsRelease(release,sourceKey);
    if(!row)continue;
    const old=byId.get(row.id);
    if(!old || String(row.publishedAt||'')>=String(old.publishedAt||''))byId.set(row.id,row);
  }
  return [...byId.values()];
}
async function syncFindATender({days=45,maxPages=20}={}) {
  const now=new Date(),from=new Date(now.getTime()-Math.max(1,days)*86400000);
  const stamp=d=>d.toISOString().slice(0,19);
  let url=new URL(FTS_URL);
  url.searchParams.set('updatedFrom',stamp(from));
  url.searchParams.set('updatedTo',stamp(now));
  url.searchParams.set('limit','100');
  const releases=[],visited=new Set();
  for(let page=0;page<Math.min(50,Math.max(1,maxPages))&&url;page++){
    if(visited.has(url.toString()))throw new Error('Find a Tender pagination loop detected');
    visited.add(url.toString());
    const payload=await getJson(url);
    releases.push(...unpackPackages(payload));
    const next=payload&&payload.links&&payload.links.next;
    if(!next){url=null;break;}
    const nextUrl=new URL(next,FTS_URL);
    if(nextUrl.origin!=='https://www.find-tender.service.gov.uk')throw new Error('Find a Tender returned an unexpected pagination host');
    url=nextUrl;
  }
  const normalized=dedupeLatest(releases,'findatender');
  const counts=saveRows('findatender',normalized);
  return {...counts,received:releases.length,normalized:normalized.length,source:'findatender',pages:visited.size};
}
async function syncContractsFinder({days=30,maxPages=10,pageDelayMs=3200}={}) {
  const now=new Date(),from=new Date(now.getTime()-Math.max(1,days)*86400000);
  const stamp=d=>d.toISOString().slice(0,19)+'Z';
  let url=new URL(CF_URL);
  url.searchParams.set('publishedFrom',stamp(from));
  url.searchParams.set('publishedTo',stamp(now));
  url.searchParams.set('size','100');
  url.searchParams.set('orderBy','publishedDate');
  url.searchParams.set('order','DESC');
  const releases=[],visited=new Set();
  for(let page=0;page<Math.min(20,Math.max(1,maxPages))&&url;page++){
    if(visited.has(url.toString()))throw new Error('Contracts Finder pagination loop detected');
    visited.add(url.toString());
    const payload=await getJson(url);
    releases.push(...unpackPackages(payload));
    const next=payload&&payload.links&&payload.links.next;
    if(!next){url=null;break;}
    const nextUrl=new URL(next,CF_URL);
    if(nextUrl.origin!=='https://www.contractsfinder.service.gov.uk')throw new Error('Contracts Finder returned an unexpected pagination host');
    url=nextUrl;
    if(url&&page+1<maxPages)await new Promise(resolve=>setTimeout(resolve,Math.max(1000,Math.min(10000,pageDelayMs))));
  }
  const normalized=dedupeLatest(releases,'contractsfinder');
  const counts=saveRows('contractsfinder',normalized);
  return {...counts,received:releases.length,normalized:normalized.length,source:'contractsfinder',pages:visited.size};
}
async function syncPublicContractsScotland({months=3}={}) {
  const releases=[],now=new Date();
  const types=[2,102];
  for(let i=0;i<Math.min(6,Math.max(1,months));i++){
    const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));
    const dateFrom=String(d.getUTCMonth()+1).padStart(2,'0')+'-'+d.getUTCFullYear();
    for(const noticeType of types){
      const url=new URL(PCS_URL);
      url.searchParams.set('dateFrom',dateFrom);
      url.searchParams.set('noticeType',String(noticeType));
      url.searchParams.set('outputType','0');
      const payload=await getJson(url);
      releases.push(...unpackPackages(payload));
    }
  }
  const normalized=dedupeLatest(releases,'pcs');
  const counts=saveRows('pcs',normalized);
  return {...counts,received:releases.length,normalized:normalized.length,source:'pcs',months:Math.min(6,Math.max(1,months))};
}
async function syncSell2Wales({months=3}={}) {
  const releases=[],now=new Date();
  const types=[2,51];
  for(let i=0;i<Math.min(6,Math.max(1,months));i++){
    const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));
    const dateFrom=String(d.getUTCMonth()+1).padStart(2,'0')+'-'+d.getUTCFullYear();
    for(const noticeType of types){
      const url=new URL(S2W_URL);
      url.searchParams.set('dateFrom',dateFrom);
      url.searchParams.set('noticeType',String(noticeType));
      url.searchParams.set('outputType','0');
      url.searchParams.set('locale','2057');
      const payload=await getJson(url);
      releases.push(...unpackPackages(payload));
    }
  }
  const normalized=dedupeLatest(releases,'sell2wales');
  const counts=saveRows('sell2wales',normalized);
  return {...counts,received:releases.length,normalized:normalized.length,source:'sell2wales',months:Math.min(6,Math.max(1,months))};
}
module.exports={normalizeOcdsRelease,unpackPackages,dedupeLatest,syncFindATender,syncContractsFinder,syncPublicContractsScotland,syncSell2Wales};
