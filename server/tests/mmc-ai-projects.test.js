'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mmc-ai-api-'));
process.env.NODE_ENV='test';
process.env.DB_PATH=path.join(TMP,'test.db');
process.env.REQUIRE_ORG_VERIFICATION='false';
process.env.UPLOAD_DIR=path.join(TMP,'uploads');
process.env.JWT_SECRET='mmc-ai-isolation-test-secret';
process.env.BCRYPT_ROUNDS='4';
const {migrate}=require('../src/migrate');
const {createApp}=require('../src/index');
const {closeDB}=require('../src/db');
let server,base;
const jar={};
async function call(user,method,url,body){
 const headers={...(jar[user]?{Cookie:jar[user]}:{})};
 let payload;
 if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
 const r=await fetch(base+url,{method,headers,body:payload,redirect:'manual'});
 for(const c of (r.headers.getSetCookie?r.headers.getSetCookie():[])){
  const first=c.split(';')[0]; if(first.startsWith('tpkit_session=')) jar[user]=first;
 }
 const data=(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text();
 return {status:r.status,data};
}
const uniq=()=>Math.random().toString(36).slice(2,10);
async function register(key){const r=await call(key,'POST','/api/auth/register',{name:key,email:key+uniq()+'@test.local',password:'Password123',company:key});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.user.id;}
test.before(async()=>{
 migrate(process.env.DB_PATH);
 const app=createApp();
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;resolve();});});
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));closeDB();fs.rmSync(TMP,{recursive:true,force:true});});

test('MMC AI project membership isolates projects and enforces viewer permissions',async()=>{
 const userA=await register('ai-owner'),userB=await register('ai-outsider'),userC=await register('ai-viewer');
 const created=await call('ai-owner','POST','/api/mmc-ai/projects',{name:'Project Alpha',country:'JO',currency:'JOD'});
 assert.equal(created.status,201,JSON.stringify(created.data));
 const projectId=created.data.project.project_id||created.data.project.id;
 assert.ok(projectId);
 assert.equal(created.data.project.role,'owner');
 const outsiderList=await call('ai-outsider','GET','/api/mmc-ai/projects');
 assert.equal(outsiderList.status,200);assert.equal(outsiderList.data.projects.length,0);
 const outsiderRead=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId);
 assert.equal(outsiderRead.status,404);
 const outsiderEdit=await call('ai-outsider','PATCH','/api/mmc-ai/projects/'+projectId,{name:'Hijack'});
 assert.equal(outsiderEdit.status,404);
 const add=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/members',{userId:userC,role:'viewer'});
 assert.equal(add.status,201,JSON.stringify(add.data));
 const viewerRead=await call('ai-viewer','GET','/api/mmc-ai/projects/'+projectId);
 assert.equal(viewerRead.status,200);
 const viewerEdit=await call('ai-viewer','PATCH','/api/mmc-ai/projects/'+projectId,{name:'Viewer edit'});
 assert.equal(viewerEdit.status,403);
 const viewerAdd=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/members',{userId:userB,role:'engineer'});
 assert.equal(viewerAdd.status,403);
 const ownB=await call('ai-outsider','POST','/api/mmc-ai/projects',{name:'Project Beta'});
 assert.equal(ownB.status,201);
 const listB=await call('ai-outsider','GET','/api/mmc-ai/projects');
 assert.equal(listB.data.projects.length,1);
 assert.notEqual(listB.data.projects[0].id,projectId);
 const auditRead=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId);
 assert.equal(auditRead.status,200);
 assert.equal(auditRead.data.members.length,2);
});
