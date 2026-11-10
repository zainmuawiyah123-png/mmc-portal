'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mmc-vendorpanel-test-'));
process.env.NODE_ENV='test';
process.env.DB_PATH=path.join(TMP,'test.db');
process.env.UPLOAD_DIR=path.join(TMP,'uploads');
process.env.JWT_SECRET='vendorpanel-test-secret-not-production';
process.env.BCRYPT_ROUNDS='4';
const {migrate}=require('../src/migrate');
const {createApp}=require('../src/index');
const {getDB,closeDB,uid}=require('../src/db');
const Auth=require('../src/lib/auth');
const {parseVendorPanelFeed}=require('../src/lib/vendorpanel-australia-sync');
let server,base;
const xml=[
'<?xml version="1.0"?><rss><channel>',
'<item><title>Road rehabilitation works</title><guid>VP Reference: VP12345</guid>',
'<description><![CDATA[Issued by: Example Roads Authority | Opened: 2026-11-01 | Closing: 2026-12-20 | VP Reference: VP12345]]></description>',
'<link>https://www.vendorpanel.com.au/PublicTenders/VP12345</link><pubDate>Mon, 02 Nov 2026 00:00:00 GMT</pubDate></item>',
'<item><title>Water treatment upgrade</title><guid>VP Reference: VP67890</guid>',
'<description><![CDATA[Issued by: Water Agency | Closing: 2026-12-31 | VP Reference: VP67890]]></description>',
'<link>https://www.vendorpanel.com.au/PublicTenders/VP67890</link></item>',
'<item><title>Rejected unsafe link</title><guid>VP99999</guid><description>Issued by: Unknown</description><link>https://example.com/not-vendorpanel</link></item>',
'</channel></rss>'
].join('');
test.before(async()=>{
 migrate(process.env.DB_PATH);
 const app=createApp();
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;resolve();});});
});
test.after(async()=>{
 await new Promise(resolve=>server.close(resolve));
 closeDB();
 fs.rmSync(TMP,{recursive:true,force:true});
});
test('VendorPanel parser retains reference and rejects non-official URLs',()=>{
 const records=parseVendorPanelFeed(xml);
 assert.equal(records.length,2);
 assert.equal(records[0].externalId,'VP12345');
 assert.equal(records[0].authority,'Example Roads Authority');
 assert.equal(records[0].closingAt,'2026-12-20');
 assert.ok(records.every(r=>r.sourceUrl.startsWith('https://www.vendorpanel.com.au/')));
});
test('admin refresh imports Australia for contractors, blocks buyers and deduplicates',async()=>{
 const db=getDB(),password=await Auth.hashPassword('Password123');
 const addUser=(role,email,name)=>{
  const id=uid('usr_');
  db.prepare('INSERT INTO users (id,email,password_hash,name,company,role,country,plan_key) VALUES (?,?,?,?,?,?,?,?)')
   .run(id,email,password,name,'Test Co',role,'JO','free');
  return Auth.signToken({id,email});
 };
 const adminToken=addUser('admin','vendor-admin@example.test','Vendor Admin');
 const contractorToken=addUser('contractor','vendor-contractor@example.test','Contractor');
 const buyerToken=addUser('buyer','vendor-buyer@example.test','Buyer');
 const originalFetch=global.fetch;
 global.fetch=async(url,...args)=>{
  if(String(url).startsWith(base))return originalFetch(url,...args);
  return new Response(xml,{status:200,headers:{'content-type':'application/rss+xml'}});
 };
 try{
  const denied=await originalFetch(base+'/api/opportunities/admin/sync/vendorpanel-australia',{method:'POST',headers:{Authorization:'Bearer '+contractorToken}});
  assert.equal(denied.status,403);
  const first=await originalFetch(base+'/api/opportunities/admin/sync/vendorpanel-australia',{method:'POST',headers:{Authorization:'Bearer '+adminToken}});
  const firstData=await first.json();
  assert.equal(first.status,200,JSON.stringify(firstData));
  assert.deepEqual([firstData.added,firstData.updated,firstData.received],[2,0,2]);
  const second=await originalFetch(base+'/api/opportunities/admin/sync/vendorpanel-australia',{method:'POST',headers:{Authorization:'Bearer '+adminToken}});
  const secondData=await second.json();
  assert.equal(second.status,200,JSON.stringify(secondData));
  assert.deepEqual([secondData.added,secondData.updated],[0,2]);
  const listed=await originalFetch(base+'/api/opportunities?source=vendorpanel-australia&country=AU',{headers:{Authorization:'Bearer '+contractorToken}});
  const listedData=await listed.json();
  assert.equal(listed.status,200);
  assert.equal(listedData.count,2);
  assert.ok(listedData.opportunities.every(o=>o.country==='AU'&&o.sourceUrl.startsWith('https://www.vendorpanel.com.au/')));
  const hidden=await originalFetch(base+'/api/opportunities?source=vendorpanel-australia&country=AU',{headers:{Authorization:'Bearer '+buyerToken}});
  assert.equal(hidden.status,403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tender_opportunities WHERE source_key='vendorpanel-australia'").get().n,2);
 }finally{
  global.fetch=originalFetch;
  db.prepare("DELETE FROM tender_opportunities WHERE source_key='vendorpanel-australia'").run();
 }
});
