'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseAusTenderRss}=require('../src/lib/austender-sync');

test('AusTender RSS imports official www links and ATM numbers',()=>{
 const xml='<rss><channel><item><title>26AMSA086: Fixed Wing Aerial Dispersant Capability</title><link>https://www.tenders.gov.au/Atm/Show/id</link><description>&lt;p&gt;Provision of capability&lt;/p&gt;</description><guid>https://www.tenders.gov.au/Atm/Show/id</guid><pubDate>Tue, 13 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>';
 const [row]=parseAusTenderRss(xml);
 assert.equal(row.tenderNumber,'26AMSA086');
 assert.equal(row.country,'AU');
 assert.equal(row.sourceUrl,'https://www.tenders.gov.au/Atm/Show/id');
});

test('AusTender parser rejects non-official links',()=>{
 const xml='<rss><channel><item><title>Unsafe</title><link>https://example.com/tender</link><guid>unsafe</guid></item></channel></rss>';
 assert.deepEqual(parseAusTenderRss(xml),[]);
});
