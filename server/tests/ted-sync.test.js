'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeTEDNotice,firstText,tedLanguageCode,noticeLinks}=require('../src/lib/ted-sync');
const {downloadPublicDocument}=require('../src/lib/public-tender-documents');

test('TED notice is normalized with one canonical PDF representation and a separate official notice URL',()=>{
 const row={
  'publication-number':'806685-2026',
  'publication-date':'2026-11-19',
  'notice-title':{'eng':'A02 Nordumfahrung Klagenfurt - E&M Wartung und Inspektion'},
  'buyer-name':{'eng':'Autobahnen- und Schnellstraßen-Finanzierungs-Aktiengesellschaft'},
  'buyer-country':'AUT',
  'document-official-language-lot':'DEU',
  'classification-cpv':['50000000'],
  'deadline-receipt-tender-date-lot':['2026-11-24'],
  'notice-type':'cn-standard',
  links:{pdf:'https://ted.europa.eu/en/notice/806685-2026/pdf',html:'https://ted.europa.eu/en/notice/806685-2026/html',xml:'https://api.ted.europa.eu/v3/notices/806685-2026'}
 };
 const item=normalizeTEDNotice(row,Date.parse('2026-11-20T00:00:00Z'));
 assert.equal(item.id,'806685-2026');
 assert.equal(item.authority,'Autobahnen- und Schnellstraßen-Finanzierungs-Aktiengesellschaft');
 assert.equal(item.country,'AT');
 assert.equal(item.status,'open');
 assert.equal(item.documents.length,1);
 assert.equal(item.documents[0].format,'pdf');
 assert.equal(item.documents[0].url,'https://ted.europa.eu/en/notice/806685-2026/pdf');
 assert.equal(item.details.officialLanguage,'de');
 assert.equal(item.language,'de');
 assert.equal(item.sourceUrl,'https://ted.europa.eu/de/notice/-/detail/806685-2026');
 assert.equal(item.details.officialLinks.length,1);
});

test('TED notice without a stable publication number or title is ignored',()=>{
 assert.equal(normalizeTEDNotice({'notice-title':'Missing number'}),null);
 assert.equal(normalizeTEDNotice({'publication-number':'123-2026'}),null);
});

test('TED text fields support language maps and nested arrays',()=>{
 assert.equal(firstText({'eng':'English title','fra':'French title'}),'English title');
 assert.equal(firstText([null,{'eng':'Nested title'}]),'Nested title');
});

test('TED official language codes map to TED URL language prefixes',()=>{
 assert.equal(tedLanguageCode('DEU'),'de');
 assert.equal(tedLanguageCode('ENG'),'en');
 assert.equal(tedLanguageCode('FRA'),'fr');
});

test('TED notice links contain exactly one canonical PDF URL',()=>{
 const links=noticeLinks({},'806685-2026','de');
 assert.equal(links.length,1);
 assert.equal(links[0].title,'Official TED notice PDF');
 assert.equal(links[0].url,'https://ted.europa.eu/de/notice/806685-2026/pdf');
 assert.equal(links[0].format,'pdf');
});


test('TED notice links prefer API-provided PDF URL in official language',()=>{
 const links=noticeLinks({links:{html:'https://ted.europa.eu/en/notice/806685-2026/html',pdf:'https://ted.europa.eu/de/notice/806685-2026/pdf',signed:'https://ted.europa.eu/de/notice/806685-2026/pdfs'}},'806685-2026','de');
 assert.equal(links.length,1);
 assert.equal(links[0].url,'https://ted.europa.eu/de/notice/806685-2026/pdf');
});

test('TED downloader accepts a real PDF even when the upstream MIME is generic',async()=>{
 const originalFetch=global.fetch;
 const bytes=Buffer.from('%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\n');
 global.fetch=async(url,options)=>{
  assert.equal(url,'https://ted.europa.eu/en/notice/806685-2026/pdf');
  assert.equal(options.redirect,'manual');
  return new Response(bytes,{status:200,headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}});
 };
 try{
  const result=await downloadPublicDocument('ted','https://ted.europa.eu/en/notice/806685-2026/pdf');
  assert.deepEqual(result.buffer,bytes);
  assert.equal(result.mime,'application/pdf');
  assert.equal(result.extension,'.pdf');
  assert.equal(result.finalUrl,'https://ted.europa.eu/en/notice/806685-2026/pdf');
 }finally{global.fetch=originalFetch;}
});

test('TED downloader rejects an HTML or login page returned from a PDF URL',async()=>{
 const originalFetch=global.fetch;
 global.fetch=async()=>new Response('<html><title>Sign in</title></html>',{status:200,headers:{'content-type':'text/html'}});
 try{
  await assert.rejects(
   downloadPublicDocument('ted','https://ted.europa.eu/en/notice/806685-2026/pdf'),
   error=>error.code==='UNSUPPORTED_MEDIA_TYPE'
  );
 }finally{global.fetch=originalFetch;}
});
