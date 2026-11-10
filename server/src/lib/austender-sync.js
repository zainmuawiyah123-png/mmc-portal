'use strict';
/** Read-only AusTender connector. Uses the Australian Government public RSS feed. */
const {getDB,uid}=require('../db');
const LIST_URL='https://tenders.gov.au/atm';
const RSS_URL='https://tenders.gov.au/public_data/rss/rss.xml';
const clean=s=>String(s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const dateISO=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10)};
function parseAusTenderRss(xml,today=new Date().toISOString().slice(0,10)){
 const rows=[];
 for(const m of String(xml||'').matchAll(/<item\b[\s\S]*?<\/item>/gi)){
  const block=m[0], val=(tag)=>{const x=block.match(new RegExp('<'+tag+'\\b[^>]*>([\\s\\S]*?)<\\/'+tag+'>','i'));return x?clean(x[1]):''};
  const guid=val('guid')||val('id'), title=val('title'), link=val('link')||LIST_URL, description=val('description'), pub=val('pubDate')||val('published');
  if(!guid||!title||!/^https:\/\/tenders\.gov\.au\//i.test(link))continue;
  const close=(description.match(/(?:close|closing|close date|closing date)[^\d]*(\d{1,2}[-/]\w+[-/]\d{4}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{4}-\d{2}-\d{2})/i)||[])[1];
  const closingAt=dateISO(close)||null, lower=(title+' '+description).toLowerCase();
  rows.push({id:guid,title:title.slice(0,300),authority:'Australian Government / AusTender',country:'AU',sector:/consult|advis|engineer|design|professional service/.test(lower)?'Consulting services':'Government procurement',tenderNumber:(title.match(/(?:ATM ID|RFT|RFI|RFQ)[:\s-]*([A-Z0-9/_-]+)/i)||[])[1]||guid,summary:description.slice(0,3000),publishedAt:dateISO(pub),closingAt,sourceUrl:link,applicationUrl:link,status:closingAt&&closingAt<today?'closed':'open',language:'en'});
 }
 const seen=new Set();return rows.filter(x=>{if(seen.has(x.id))return false;seen.add(x.id);return true});
}
async function fetchRss(){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);try{const r=await fetch(RSS_URL,{headers:{Accept:'application/rss+xml,application/xml,text/xml','User-Agent':'MMC-Tender-Directory/1.0'},signal:controller.signal});if(!r.ok)throw new Error('AusTender RSS HTTP '+r.status);return await r.text()}finally{clearTimeout(timer)}}
async function syncAusTender(){const notices=parseAusTenderRss(await fetchRss());if(!notices.length)throw new Error('AusTender RSS returned no valid notices; no database changes were made.');const db=getDB(),up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language) VALUES (@rowId,'austender',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language) ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,source_url=excluded.source_url,application_url=excluded.application_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()`);const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare("SELECT id FROM tender_opportunities WHERE source_key='austender' AND external_id=?").get(n.id),id=old?old.id:uid('opp_');up.run({rowId:id,externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});old?updated++:added++}return{added,updated}});return{...tx(notices),received:notices.length,normalized:notices.length,source:'austender',sourceUrl:RSS_URL}}
module.exports={LIST_URL,RSS_URL,parseAusTenderRss,syncAusTender};
