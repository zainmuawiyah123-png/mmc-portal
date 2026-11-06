'use strict';
/**
 * Read-only importer for Jordan Phosphate Mines Company public tender notices.
 * It reads the public listing/details links only; it never logs in, buys documents,
 * submits bids, or accesses supplier-only information.
 */
const LIST_URL = 'https://www.jpmc.com.jo/ar/tender';
const ORIGIN = 'https://www.jpmc.com.jo';
const clean = s => String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim();
function dateISO(value) {
  const m = String(value || '').match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (!m) return null;
  const d=Number(m[1]), mo=Number(m[2]), y=Number(m[3]), dt=new Date(Date.UTC(y,mo-1,d));
  if (dt.getUTCFullYear()!==y || dt.getUTCMonth()!==mo-1 || dt.getUTCDate()!==d) return null;
  return y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function parseJpmcRows(html, today) {
  const source=String(html || ''), out=[], seen=new Set();
  const todayISO=today || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date());
  const headings=[...source.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  for (let i=0;i<headings.length;i++) {
    const h=headings[i], title=clean(h[1]);
    if (!/(?:T\d{4}\s*\/\s*\d+|عطاء|مناقصة|مزاودة)/i.test(title)) continue;
    const start=h.index, end=i+1<headings.length?headings[i+1].index:Math.min(source.length,start+5000);
    const before=source.slice(Math.max(0,start-900),start), after=source.slice(h.index+h[0].length,end);
    const context=clean(source.slice(Math.max(0,start-500),end));
    const closingMatch=before.match(/تاريخ\s*(?:انتهاء|إغلاق)\s*العطاء\s*[:：]?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i)
      || context.match(/تاريخ\s*(?:انتهاء|إغلاق)\s*العطاء\s*[:：]?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i);
    const publishedMatch=before.match(/تاريخ\s*بدء\s*العطاء\s*[:：]?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i)
      || context.match(/تاريخ\s*بدء\s*العطاء\s*[:：]?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i);
    const linkMatch=after.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?(?:اقرأ\s*المزيد|التفاصيل|read\s*more)[\s\S]*?<\/a>/i)
      || after.match(/<a\b[^>]*href=["']([^"']+)["']/i);
    let sourceUrl=LIST_URL;
    if (linkMatch) { try { const u=new URL(linkMatch[1],LIST_URL); if(u.origin===ORIGIN) sourceUrl=u.toString(); } catch(_) {} }
    const number=(title.match(/(T\d{4}\s*\/\s*\d+\s*[A-Z]*)/i)||[])[1];
    const id=(sourceUrl!==LIST_URL?sourceUrl.split('/').filter(Boolean).pop():number||title).slice(0,180);
    if (seen.has(id)) continue;
    seen.add(id);
    const closingAt=closingMatch?dateISO(closingMatch[1]):null;
    const publishedAt=publishedMatch?dateISO(publishedMatch[1]):null;
    out.push({id,title:title.slice(0,300),authority:'شركة مناجم الفوسفات الأردنية / Jordan Phosphate Mines Company',
      country:'JO',sector:/أعمال|إنشاء|تأهيل|صيانة|طريق|مباني|مستودعات|خرسانة|حفريات/i.test(title)?'أعمال مدنية وإنشائية':null,
      tenderNumber:number?number.replace(/\s+/g,' '):null,
      summary:'إعلان عطاء من الصفحة الرسمية لشركة مناجم الفوسفات الأردنية. يرجى مراجعة الإعلان الأصلي للتحقق من الشروط والوثائق.',
      publishedAt,closingAt,sourceUrl,applicationUrl:null,
      status:closingAt&&closingAt<todayISO?'closed':'open',language:'ar'});
  }
  return out;
}
async function syncJPMC() {
  const {getDB,uid}=require('../db');
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
  let html;
  try {
    const r=await fetch(LIST_URL,{headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; MMC-Tender-Directory/1.0)'},signal:controller.signal});
    if(!r.ok) throw new Error('JPMC returned HTTP '+r.status);
    html=await r.text();
  } finally { clearTimeout(timer); }
  const rows=parseJpmcRows(html);
  if(!rows.length) throw new Error('JPMC page loaded but no recognizable tender notices were found; importer stopped without changing records.');
  const db=getDB();
  const upsert=db.prepare(`INSERT INTO tender_opportunities
    (id,source_key,external_id,title,authority,country,sector,tender_number,summary,published_at,closing_at,source_url,application_url,status,language)
    VALUES (@rowId,'jpmc',@externalId,@title,@authority,@country,@sector,@tenderNumber,@summary,@publishedAt,@closingAt,@sourceUrl,@applicationUrl,@status,@language)
    ON CONFLICT(source_key,external_id) DO UPDATE SET title=excluded.title,authority=excluded.authority,country=excluded.country,
    sector=excluded.sector,tender_number=excluded.tender_number,summary=excluded.summary,published_at=excluded.published_at,
    closing_at=excluded.closing_at,source_url=excluded.source_url,status=excluded.status,language=excluded.language,updated_at=unixepoch()`);
  const tx=db.transaction(items=>{let added=0,updated=0;for(const n of items){
    const old=db.prepare('SELECT id FROM tender_opportunities WHERE source_key=? AND external_id=?').get('jpmc',n.id);
    upsert.run({rowId:old?old.id:uid('opp_'),externalId:n.id,title:n.title,authority:n.authority,country:n.country,sector:n.sector,
      tenderNumber:n.tenderNumber,summary:n.summary,publishedAt:n.publishedAt,closingAt:n.closingAt,sourceUrl:n.sourceUrl,
      applicationUrl:n.applicationUrl,status:n.status,language:n.language});
    if(old)updated++;else added++;
  }return {added,updated};});
  return {...tx(rows),received:rows.length,normalized:rows.length,source:'jpmc',sourceUrl:LIST_URL};
}
module.exports={parseJpmcRows,syncJPMC,LIST_URL};
