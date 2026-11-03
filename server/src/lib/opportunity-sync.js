'use strict';
/**
 * Connectors for public procurement feeds.
 * World Bank publishes a public procurement-notices API; no API key is required.
 * JONEPS is intentionally not scraped: no stable public API contract has been confirmed.
 */
const { getDB, uid } = require('../db');

const WB_URL = 'https://search.worldbank.org/api/v2/procnotices';
const clean = (v,n=3000) => String(v == null ? '' : v).trim().slice(0,n);
function normalizeWorldBankNotice(row) {
  const id=clean(row.id || row.notice_id || row.noticeId,160);
  const title=clean(row.bid_description || row.notice_text || row.title || row.description,300);
  if(!id||!title) return null;
  const rawUrl=clean(row.url || row.notice_url,1000);
  const sourceUrl=/^https:\/\//i.test(rawUrl)?rawUrl:'https://projects.worldbank.org/en/projects-operations/procurement-detail/'+encodeURIComponent(id);
  const deadline=clean(row.deadline_date || row.submission_date || row.deadline,40);
  const pub=clean(row.publication_date || row.notice_date || row.noticedate,40);
  const countryCode=clean(row.country_code || row.project_ctry_code,3).toUpperCase();
  const countryName=clean(row.country_name || row.project_ctry_name,100);
  const country=(/^[A-Z]{2}$/.test(countryCode)?countryCode:(countryCode==='INT'?'INT':(/jordan/i.test(countryName)?'JO':/saudi/i.test(countryName)?'SA':/united arab emirates|uae/i.test(countryName)?'AE':'INT')));
  const noticeType=clean(row.notice_type,100);
  const status=deadline && /^\d{4}-\d{2}-\d{2}/.test(deadline) && deadline.slice(0,10)<new Date().toISOString().slice(0,10)?'closed':'open';
  return {
    id, title, authority:'World Bank financed project',
    country, sector:clean(row.sector || row.procurement_category,100)||null,
    tenderNumber:id, summary:[noticeType,clean(row.procurement_method,100),countryName].filter(Boolean).join(' · ')+' — '+clean(row.bid_description || row.notice_text,2500),
    publishedAt:pub||null, closingAt:deadline||null, sourceUrl,
    applicationUrl:null,status,language:'en'
  };
}
async function syncWorldBank({rows=100,offset=0}={}) {
  const url=new URL(WB_URL);
  url.searchParams.set('format','json');url.searchParams.set('rows',String(Math.min(200,Math.max(1,rows))));
  url.searchParams.set('os',String(Math.max(0,offset)));url.searchParams.set('srt','noticedate desc,id asc');
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
  let payload;
  try {
    const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'MMC-Tender-Directory/1.0'},signal:controller.signal});
    if(!response.ok) throw new Error('World Bank API returned HTTP '+response.status);
    payload=await response.json();
  } finally { clearTimeout(timer); }
  const source=payload.procnotices || payload.notices || payload;
  const values=Array.isArray(source)?source:Object.values(source).filter(x=>x&&typeof x==='object');
  const mapped=values.map(normalizeWorldBankNotice).filter(Boolean);
  const db=getDB();
  const upsert=db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
    VALUES (@rowId,'worldbank',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
    ON CONFLICT(source_key,external_id) DO UPDATE SET
    title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,
    tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
    closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,
    language=excluded.language,updated_at=unixepoch()`);
  const tx=db.transaction(items=>{
    let added=0,updated=0;
    for(const item of items){
      const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('worldbank',item.id);
      upsert.run({rowId:old?old.id:uid('opp_'),externalId:item.id,title:item.title,authority:item.authority,country:item.country,sector:item.sector,tenderNumber:item.tenderNumber,summary:item.summary,publishedAt:item.publishedAt,closingAt:item.closingAt,sourceUrl:item.sourceUrl,applicationUrl:item.applicationUrl,status:item.status,language:item.language});
      if(old)updated++;else added++;
    }
    return {added,updated};
  });
  const counts=tx(mapped);
  return {...counts,received:values.length,normalized:mapped.length,source:'worldbank'};
}
module.exports={normalizeWorldBankNotice,syncWorldBank};
