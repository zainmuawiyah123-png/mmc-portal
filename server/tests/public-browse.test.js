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
 assert.equal(p.status,200);assert.ok(Array.isArray(p.data.tenders));assert.equal(typeof p.data.count,'number');
 assert.equal(c.status,200);assert.ok(Array.isArray(c.data.opportunities));assert.equal(typeof c.data.count,'number');
 assert.equal(s.status,200);assert.ok(Array.isArray(s.data.requests));assert.equal(typeof s.data.count,'number');
 for(const r of [p,c,s])assert.match(r.headers.get('cache-control')||'',/public/);
});
test('public browse feeds do not expose protected submission or identity routes',async()=>{
 for(const url of ['/api/public/procurement/tenders','/api/public/contractor/opportunities','/api/public/consulting/requests']){
  const r=await get(url);const body=JSON.stringify(r.data);
  for(const secret of ['password_hash','financial_amount','contractor_id','submitted_ip','storage_key','contact_email','registration_number','owner_email'])assert.ok(!body.includes(secret),'leaked '+secret);
 }
});
test('public portal screens are served as real interactive pages',async()=>{
 for(const p of ['procurement','contractor','consultant']){
  const r=await get('/public-browse/'+p+'.html');
  assert.equal(r.status,200);assert.match(r.data,/PUBLIC BROWSE MODE/);assert.match(r.data,/fetch\('\/api\/public/);
 }
});
