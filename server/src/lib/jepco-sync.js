'use strict';
/** Read-only importer for the public Jordan Electric Power Company tender table. */
const LIST_URL='https://www.jepco.com.jo/ar/Home/عرض-المناقصات-الحالية',ORIGIN='https://www.jepco.com.jo';
const clean=s=>String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();
function dateISO(v){const m=String(v||'').match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);if(!m)return null;const d=+m[1],mo=+m[2],y=+m[3],dt=new Date(Date.UTC(y,mo-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;}
function parseJepcoRows(html,today){const out=[],seen=new Set(),todayISO=today||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
 for(const tr of String(html||'').matchAll(/<tr\b[\s\S]*?<\/tr>/gi)){const cells=[...tr[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);if(cells.length<3)continue;
  const number=clean(cells[0]),title=clean(cells[1]),deadline=dateISO(clean(cells[cells.length-1]));if(!/^\d+\s*\/\s*\d{4}$/.test(number)||!title)continue;
  let sourceUrl=LIST_URL;const a=(tr[0].match(/<a\b[^>]*href=["']([^"']+)["']/i)||[])[1];if(a){try{const u=new URL(a,LIST_URL);if(u.origin===ORIGIN)sourceUrl=u.toString();}catch(_){}}
  const id=number.replace(/\s+/g,'');if(seen.has(id))continue;seen.add(id);
  out.push({id,title:title.slice(0,300),authority:'شركة الكهرباء الأردنية / Jordan Electric Power Company (JEPCO)',country:'JO',sector:/transformer|cable|conductor|isolator|محطة|كهرباء|محولات/i.test(title)?'معدات وأعمال كهربائية':null,tenderNumber:id,summary:'إعلان مناقصة من الموقع الرسمي لشركة الكهرباء الأردنية. راجع الموقع الرسمي للشروط ونسخة المواصفات.',publishedAt:null,closingAt:deadline,sourceUrl,applicationUrl:null,status:deadline&&deadline<todayISO?'closed':'open',language:/[A-Za-z]/.test(title)?'en':'ar'});
 }return out;}
async function syncJEPCO(){const {getDB,uid}=require('../db');const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000);let html;
 try{const r=await fetch(LIST_URL,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:ctl.signal});if(!r.ok)throw new Error('JEPCO returned HTTP '+r.status);html=await r.text();}finally{clearTimeout(timer);}
 const rows=parseJepcoRows(html);if(!rows.length)throw new Error('JEPCO page returned no recognizable tender table rows; no records changed.');
 const db=getDB(),up=db.prepare(`INSERT INTO tender_opportunities (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
 VALUES (@rowId,'jepco',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
 ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,updated_at=unixepoch()`);
 const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jepco',n.id);up.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,applicationUrl:n.applicationUrl,status:n.status,language:n.language});if(old)updated++;else added++;}return{added,updated};});
 return{...tx(rows),received:rows.length,normalized:rows.length,source:'jepco',sourceUrl:LIST_URL};}
module.exports={parseJepcoRows,syncJEPCO,LIST_URL};
