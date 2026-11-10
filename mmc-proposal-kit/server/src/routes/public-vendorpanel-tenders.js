'use strict';
const express = require('express');
const crypto = require('crypto');
const FEED_URL = 'https://www.vendorpanel.com.au/PublicTendersRssV2.aspx?mode=all';
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, count: 0 };
function decodeXml(v) {
 return String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&nbsp;|&#160;/gi,' ')
 .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;|&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
 .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function tag(xml,name) {
 const re=new RegExp('<(?:[\\\\w.-]+:)?'+name+'\\\b[^>]*>([\\\s\\\S]*?)<\\\\/(?:[\\\\w.-]+:)?'+name+'\\\s*>','i');
 const m=String(xml||'').match(re);
 return m?decodeXml(m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()):'';
}
function safeUrl(value) {
 try { const u=new URL(value); return u.protocol==='https:'&&(u.hostname==='vendorpanel.com.au'||u.hostname.endsWith('.vendorpanel.com.au'))?u.toString():''; } catch(_){return '';}
}
function dateOnly(value) { if(!value)return null; const d=new Date(value); return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10); }
function parseVendorPanelFeed(xml) {
 const entries=[...String(xml||'').matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi)].map(m=>m[1]);
 if(!entries.length)throw new Error('VendorPanel RSS feed contained no item/entry records');
 return entries.map(entry=>{
  const title=tag(entry,'title'),description=tag(entry,'description')||tag(entry,'summary')||tag(entry,'content');
  const lm=entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  const link=safeUrl(tag(entry,'link')||(lm&&lm[1]));
  const guid=tag(entry,'guid')||tag(entry,'id')||link;
  const body=decodeXml(description).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const refMatch=body.match(/\bVP\s*Reference\s*:\s*(VP\d+)/i)||guid.match(/\bVP\d+\b/i);
  const ref=refMatch?(refMatch[1]||refMatch[0]):guid;
  const publisher=(body.match(/\bIssued\s+by\s*:\s*([^|]+?)(?=\s+VP\s*Reference\s*:|\s+Opened\s*:|\s+Closing\s*:|$)/i)||[])[1];
  const closing=(body.match(/\bClosing\s*:\s*([^|]+?)(?=\s+Opened\s*:|\s+VP\s*Reference\s*:|$)/i)||[])[1];
  const opened=(body.match(/\bOpened\s*:\s*([^|]+?)(?=\s+Closing\s*:|\s+VP\s*Reference\s*:|$)/i)||[])[1];
  const pubDate=tag(entry,'pubDate')||tag(entry,'published')||tag(entry,'updated');
  if(!title||!link||!ref)return null;
  return {id:'vp-'+crypto.createHash('sha1').update(String(ref)).digest('hex').slice(0,20),sourceRef:String(ref),title,
   description:body||null,publisherName:publisher?publisher.trim():'VendorPanel Public Tenders',
   closingAt:dateOnly(closing),publishedAt:dateOnly(pubDate||opened),officialUrl:link};
 }).filter(Boolean);
}
function persist(tenders) {
 const db=require('../db').getDB();
 db.prepare(`INSERT INTO tender_sources
 (source_key,name_ar,name_en,country_code,market_scope,publisher_type,source_url,connector_status,access_mode,last_synced_at,last_sync_status,last_sync_message)
 VALUES ('vendorpanel-australia','عطاءات VendorPanel العامة — أستراليا','VendorPanel Public Tenders — Australia','AU','national','public-marketplace',?,'active','Public RSS feed; public tender information may be redistributed with source attribution',unixepoch(),'success',?)
 ON CONFLICT(source_key) DO UPDATE SET connector_status='active',last_synced_at=unixepoch(),last_sync_status='success',last_sync_message=excluded.last_sync_message,updated_at=unixepoch()`)
 .run(FEED_URL,'Imported '+tenders.length+' public RSS records');
 const upsert=db.prepare(`INSERT INTO public_tenders
 (id,source_key,source_ref,country_code,market_scope,publisher_type,publisher_name,tender_number,title,description,published_at,closing_at,status,official_url,last_verified_at,review_status,raw_metadata)
 VALUES (@id,'vendorpanel-australia',@sourceRef,'AU','national','public-marketplace',@publisherName,@tenderNumber,@title,@description,@publishedAt,@closingAt,@status,@officialUrl,unixepoch(),'published',@rawMetadata)
 ON CONFLICT(source_key,source_ref) DO UPDATE SET publisher_name=excluded.publisher_name,tender_number=excluded.tender_number,title=excluded.title,
 description=excluded.description,published_at=excluded.published_at,closing_at=excluded.closing_at,status=excluded.status,official_url=excluded.official_url,
 last_verified_at=unixepoch(),fetched_at=unixepoch(),raw_metadata=excluded.raw_metadata,updated_at=unixepoch()`);
 db.transaction(()=>tenders.forEach(t=>{
  const status=t.closingAt?(t.closingAt<new Date().toISOString().slice(0,10)?'closed':'open'):'unknown';
  upsert.run({...t,tenderNumber:(t.sourceRef.match(/\bVP\d+\b/i)||[])[0]||t.sourceRef,status,rawMetadata:JSON.stringify(t)});
 }))();
}
async function load(force) {
 if(!force&&cache.at&&Date.now()-cache.at<CACHE_MS)return cache;
 const response=await fetch(FEED_URL,{headers:{'user-agent':'MMC-Tender-Directory/1.0 (public RSS feed consumer)','accept':'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('VendorPanel RSS returned HTTP '+response.status);
 const tenders=parseVendorPanelFeed(await response.text());persist(tenders);
 cache={at:Date.now(),count:tenders.length};return cache;
}
const router=express.Router();
router.get('/',async(req,res)=>{
 try { const r=await load(req.query.refresh==='1');res.set('Cache-Control','private, max-age=60');res.json({source:'VendorPanel Public Tenders — Australia',feedUrl:FEED_URL,fetchedAt:new Date(r.at).toISOString(),count:r.count,status:'success'}); }
 catch(error) {
  require('../db').getDB().prepare("UPDATE tender_sources SET connector_status='degraded',last_synced_at=unixepoch(),last_sync_status='failed',last_sync_message=?,updated_at=unixepoch() WHERE source_key='vendorpanel-australia'").run(error.message);
  res.status(502).json({error:{code:'SOURCE_UNAVAILABLE',message:'تعذر تحديث عطاءات VendorPanel حالياً.'},detail:error.message});
 }
});
module.exports={router,parseVendorPanelFeed,FEED_URL};
