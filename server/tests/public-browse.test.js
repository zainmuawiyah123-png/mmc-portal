'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mmc-public-browse-'));
process.env.NODE_ENV='test';
process.env.DB_PATH=path.join(TMP,'test.db');
process.env.UPLOAD_DIR=path.join(TMP,'uploads');
process.env.JWT_SECRET='public-browse-test-secret';
process.env.BCRYPT_ROUNDS='4';
const {migrate}=require('../src/migrate');
const {createApp}=require('../src/index');
const {closeDB}=require('../src/db');
let server,base;
async function get(url){const r=await fetch(base+url,{redirect:'manual'});const type=r.headers.get('content-type')||'';return {status:r.status,data:type.includes('application/json')?await r.json():await r.text(),headers:r.headers};}
test.before(async()=>{migrate(process.env.DB_PATH);const app=createApp();await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;resolve();});});});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));closeDB();fs.rmSync(TMP,{recursive:true,force:true});});
test('public browse feeds are readable without a session and return safe collection shapes',async()=>{
 const p=await get('/api/public/procurement/tenders');
 const c=await get('/api/public/contractor/opportunities');
 const s=await get('/api/public/consulting/requests');
 const sf=await get('/api/public/consulting/firm-tenders');
 assert.equal(p.status,200);assert.ok(Array.isArray(p.data.tenders));assert.equal(typeof p.data.count,'number');
 assert.equal(c.status,200);assert.ok(Array.isArray(c.data.opportunities));assert.equal(typeof c.data.count,'number');
 assert.equal(s.status,200);assert.ok(Array.isArray(s.data.requests));assert.equal(typeof s.data.count,'number');
 assert.equal(sf.status,200);assert.ok(Array.isArray(sf.data.tenders));assert.equal(typeof sf.data.count,'number');
 // The contractor opportunities feed is intentionally not cacheable because it is a live market listing.
 assert.match(c.headers.get('cache-control')||'',/no-store/);
 for(const r of [p,s,sf])assert.match(r.headers.get('cache-control')||'',/public/);
});
test('public browse feeds do not expose protected submission or identity routes',async()=>{
 for(const url of ['/api/public/procurement/tenders','/api/public/contractor/opportunities','/api/public/consulting/requests','/api/public/consulting/firm-tenders']){
  const r=await get(url);const body=JSON.stringify(r.data);
  for(const secret of ['password_hash','financial_amount','contractor_id','submitted_ip','storage_key','contact_email','registration_number','owner_email'])assert.ok(!body.includes(secret),'leaked '+secret);
 }
});
test('anonymous portal entry URLs serve the original portal screens without redirecting',async()=>{
 for(const [url,marker] of [['/procurement/','إنشاء عطاء إلكتروني'],['/bid/','العطاءات المتاحة'],['/consulting/','لوحة إدارة المكتب الاستشاري']]){
  const r=await get(url);assert.equal(r.status,200);assert.equal(r.headers.get('location'),null);assert.match(r.data,new RegExp(marker));
 }
});
test('main portal gateways lead to public browse first and the full consultant office portal',async()=>{
 const ar=await get('/index-ar.html'),en=await get('/index.html');
 assert.equal(ar.status,200);assert.equal(en.status,200);
 assert.ok(ar.data.includes('href="/bid/"'),'Arabic contractor gateway must open public contractor portal');
 assert.ok(ar.data.includes('href="/procurement/"'),'Arabic procurement gateway must open public procurement view');
 assert.ok(en.data.includes('href="/bid/"'),'English contractor gateway must open public contractor portal');
 assert.ok(en.data.includes('href="/consulting/"'),'English consultant gateway must open full office portal');
 const legacy=await get('/public-browse/consultant.html');
 assert.equal(legacy.status,302);assert.equal(legacy.headers.get('location'),'/consulting/');
 const full=await get('/consulting/');assert.equal(full.status,200);assert.match(full.data,/لوحة إدارة المكتب الاستشاري/);
});

test('write and submission operations remain protected for anonymous visitors',async()=>{
 for(const [url,method] of [['/api/procurement/tenders','POST'],['/api/consulting/requests','POST'],['/api/procurement/tenders/example/submit','POST'],['/api/public/procurement/tenders','POST'],['/api/project-finance/awards','POST'],['/api/project-finance/awards','GET'],['/api/committee/my-assignments','GET'],['/api/opportunities/feed','GET'],['/api/opportunities/admin','GET']]){
  const options={method,headers:{'Content-Type':'application/json'},redirect:'manual'};
  if(!['GET','HEAD'].includes(method)) options.body='{}';
  const r=await fetch(base+url,options);
  assert.ok([401,403,404].includes(r.status),'unexpected anonymous write response '+method+' '+url+': '+r.status);
 }
});
test('original portal screens include explicit public browse behavior',async()=>{
 const p=await get('/procurement/'),b=await get('/bid/'),s=await get('/consulting/');
 assert.match(p.data,/publicLoad/);assert.ok(p.data.includes('/public/procurement/tenders'));
 assert.match(b.data,/publicLoad/);assert.ok(b.data.includes('/public/contractor/opportunities'));
 assert.match(s.data,/publicLoad/);assert.ok(s.data.includes('/api/public/consulting/requests'));
});

test('anonymous users cannot read award, purchase order, invoice, committee or contractor market APIs', async () => {
 for (const url of ['/api/project-finance/awards','/api/project-finance/purchase-orders','/api/project-finance/invoices','/api/committee/my-assignments','/api/opportunities/feed']) {
  const r=await get(url); assert.equal(r.status,401,'expected authentication for '+url);
 }
});
