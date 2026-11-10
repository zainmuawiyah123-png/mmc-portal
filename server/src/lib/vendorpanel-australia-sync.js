'use strict';
const FEED_URL='https://www.vendorpanel.com.au/PublicTendersRssV2.aspx?mode=all';
const clean=(v,n=3000)=>String(v==null?'':v).trim().slice(0,n);
function decodeXml(v){
 return String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;|&#39;/gi,"'")
  .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function tag(xml,name){
 const re=new RegExp('<'+name+'[^>]*>([\s\S]*?)</'+name+'>','i');
 const m=String(xml||'').match(re);
 return m?decodeXml(m[1]).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():'';
}
function safeUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='vendorpanel.com.au'||u.hostname.endsWith('.vendorpanel.com.au'))?u.toString():'';}catch(_){return '';}
}
function dateOnly(value){
 if(!value)return null;
 const raw=String(value).trim();
 const iso=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
 if(iso)return iso[1]+'-'+iso[2].padStart(2,'0')+'-'+iso[3].padStart(2,'0');
 const d=new Date(raw);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
function parseVendorPanelFeed(xml){
 const entries=[...String(xml||'').matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi)].map(m=>m[1]);
 if(!entries.length)throw new Error('VendorPanel RSS feed contained no item/entry records');
 return entries.map(entry=>{
  const title=clean(tag(entry,'title'),300);
  const description=tag(entry,'description')||tag(entry,'summary')||tag(entry,'content');
  const lm=entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  const link=safeUrl(tag(entry,'link')||(lm&&lm[1]));
  const guid=tag(entry,'guid')||tag(entry,'id')||link;
  const body=clean(decodeXml(description).replace(/<[^>]+>/g,' ').replace(/\s+/g,' '),3000);
  const refMatch=body.match(/\bVP\s*Reference\s*:\s*(VP\d+)/i)||guid.match(/\bVP\d+\b/i);
  const ref=refMatch?(refMatch[1]||refMatch[0]):clean(guid,160);
  const publisher=(body.match(/\bIssued\s+by\s*:\s*([^|]+?)(?=\s+VP\s*Reference\s*:|\s+Opened\s*:|\s+Closing\s*:|$)/i)||[])[1];
  const closing=(body.match(/\bClosing\s*:\s*([^|]+?)(?=\s+Opened\s*:|\s+VP\s*Reference\s*:|$)/i)||[])[1];
  const opened=(body.match(/\bOpened\s*:\s*([^|]+?)(?=\s+Closing\s*:|\s+VP\s*Reference\s*:|$)/i)||[])[1];
  const published=tag(entry,'pubDate')||tag(entry,'published')||tag(entry,'updated');
  if(!title||!link||!ref)return null;
  return {externalId:ref,title,authority:clean(publisher,200)||'VendorPanel Public Tenders',
   summary:body||null,tenderNumber:ref,publishedAt:dateOnly(published||opened),closingAt:dateOnly(closing),
   sourceUrl:link,status:'open',language:'en'};
 }).filter(Boolean);
}
async function syncVendorPanelAustralia({fetchImpl=global.fetch}={}){
 const response=await fetchImpl(FEED_URL,{headers:{'user-agent':'MMC-Tender-Directory/1.0 (public RSS feed consumer)','accept':'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('VendorPanel RSS returned HTTP '+response.status);
 const records=parseVendorPanelFeed(await response.text());
 const {getDB,uid}=require('../db'),db=getDB();
 const upsert=db.prepare("INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language) VALUES (@id,'vendorpanel-australia',@externalId,@title,@authority,'AU',NULL,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,NULL,@status,@language) ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country='AU',tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()");
 const today=new Date().toISOString().slice(0,10);
 const tx=db.transaction(items=>{
  let added=0,updated=0;
  for(const item of items){
   const old=db.prepare("SELECT id FROM tender_opportunities WHERE source_key='vendorpanel-australia' AND external_id=?").get(item.externalId);
   const status=item.closingAt&&item.closingAt<today?'closed':'open';
   upsert.run({...item,id:old?old.id:uid('opp_'),status});
   if(old)updated++;else added++;
  }
  return {added,updated};
 });
 const counts=tx(records);
 return {...counts,received:records.length,normalized:records.length,source:'vendorpanel-australia',country:'AU',feedUrl:FEED_URL};
}
module.exports={FEED_URL,parseVendorPanelFeed,syncVendorPanelAustralia};
