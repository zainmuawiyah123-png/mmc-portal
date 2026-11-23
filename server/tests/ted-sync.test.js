'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeTEDNotice,firstText,noticeLinks}=require('../src/lib/ted-sync');

test('TED notice is normalized into MMC opportunity fields',()=>{
 const row={
  'publication-number':'123456-2026',
  'publication-date':'2026-11-20',
  'notice-title':{'eng':'Road rehabilitation works'},
  'buyer-name':{'eng':'City Council'},
  'buyer-country':'NLD',
  'classification-cpv':['45233100'],
  'place-of-performance':{'nuts':{'NL':'NL32'}},
  'deadline-receipt-tender-date-lot':['2026-12-20'],
  'notice-type':'cn-standard',
  'procedure-type':'open'
 };
 const item=normalizeTEDNotice(row,Date.parse('2026-11-23T00:00:00Z'));
 assert.equal(item.id,'123456-2026');
 assert.equal(item.title,'Road rehabilitation works');
 assert.equal(item.authority,'City Council');
 assert.equal(item.country,'NL');
 assert.equal(item.status,'open');
 assert.equal(item.closingAt,'2026-12-20T00:00:00.000Z');
 assert.equal(item.sourceKey,undefined);
 assert.match(item.sourceUrl,/123456-2026/);
 assert.equal(item.details.publicationNumber,'123456-2026');
});

test('TED notice without a stable publication number or title is ignored',()=>{
 assert.equal(normalizeTEDNotice({'notice-title':'Missing number'}),null);
 assert.equal(normalizeTEDNotice({'publication-number':'123-2026'}),null);
});

test('TED text fields support language maps and nested arrays',()=>{
 assert.equal(firstText({'eng':'English title','fra':'French title'}),'English title');
 assert.equal(firstText([null,{'eng':'Nested title'}]),'Nested title');
});

test('TED official document links are deduplicated and limited to official hosts',()=>{
 const links=noticeLinks({links:{
  pdf:'https://ted.europa.eu/en/notice/123.pdf',
  xml:'https://api.ted.europa.eu/v3/notices/123.xml',
  unsafe:'https://example.com/file.pdf',
  duplicate:'https://ted.europa.eu/en/notice/123.pdf'
 }});
 assert.equal(links.length,2);
 assert.ok(links.every(x=>/^https:\/\/(api\.)?ted\.europa\.eu\//.test(x.url)));
});
