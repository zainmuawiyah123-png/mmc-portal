'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mmc-ai-pdf-takeoff-'));
process.env.NODE_ENV='test';
process.env.DB_PATH=path.join(TMP,'test.db');
process.env.REQUIRE_ORG_VERIFICATION='false';
process.env.UPLOAD_DIR=path.join(TMP,'uploads');
process.env.JWT_SECRET='mmc-ai-pdf-takeoff-test-secret';
process.env.BCRYPT_ROUNDS='4';
const {migrate}=require('../src/migrate');
const {createApp}=require('../src/index');
const {closeDB}=require('../src/db');
const {extractPdfTextPoppler}=require('../src/lib/mmc-ai/pdf-poppler-text');
const {parseStructuralScheduleText}=require('../src/lib/mmc-ai/pdf-structural-takeoff');
const fixturePath=path.join(__dirname,'fixtures/MMC_AI_Structural_Takeoff_Test.pdf');
const fixture=fs.readFileSync(fixturePath);
let server,base;
const jar={};
const nonce=()=>crypto.randomBytes(5).toString('hex');
async function call(user,method,url,body){
 const headers={...(jar[user]?{Cookie:jar[user]}:{})};let payload;
 if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
 const response=await fetch(base+url,{method,headers,body:payload,redirect:'manual'});
 for(const cookie of (response.headers.getSetCookie?response.headers.getSetCookie():[])){
  const first=cookie.split(';')[0];if(first.startsWith('tpkit_session='))jar[user]=first;
 }
 const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text();
 return {status:response.status,data};
}
async function register(name){
 const response=await call(name,'POST','/api/auth/register',{name,email:name+'-'+nonce()+'@test.local',password:'Password123',company:name});
 assert.equal(response.status,201,JSON.stringify(response.data));return response.data.user.id;
}
async function upload(user,projectId,name,bytes){
 const form=new FormData();form.append('file',new Blob([bytes]),name);
 const response=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/documents',{method:'POST',headers:{...(jar[user]?{Cookie:jar[user]}:{})},body:form});
 const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text();
 return {status:response.status,data};
}

test.before(async()=>{
 migrate(process.env.DB_PATH);
 const app=createApp();
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;resolve();});});
});
test.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));closeDB();fs.rmSync(TMP,{recursive:true,force:true});});

test('Poppler extracts the actual two-page synthetic structural PDF and the parser matches the golden quantities',async()=>{
 const extracted=await extractPdfTextPoppler(fixture);
 assert.equal(extracted.status,'partial_text_extracted');assert.equal(extracted.pageCount,2);assert.match(extracted.text,/STRUCTURAL ELEMENT SCHEDULE/);
 const result=parseStructuralScheduleText(extracted.text);
 assert.equal(result.engine,'mmc-pdf-structural-schedule-v0.1');assert.equal(result.status,'needs_review');
 assert.equal(result.summary.concrete_m3,12.24);assert.equal(result.summary.rebar_kg,892.78);
 assert.deepEqual(result.summary.rebar_length_by_diameter_m,{D8:289.2,D12:489,D16:217.6});
 assert.deepEqual(result.summary.rebar_kg_by_diameter,{D8:114.25,D12:434.67,D16:343.86});
 assert.equal(result.summary.bar_schedule_marks,8);assert.equal(result.rows.length,7);
 assert.match(result.rows[2].detail.formula,/450 - 150/);assert.equal(result.rows[0].detail.sourcePage,1);assert.equal(result.rows[4].detail.marks[0].sourcePage,2);
});

test('parser fails closed when a required dimension or bar schedule total is missing or inconsistent',async()=>{
 const extracted=await extractPdfTextPoppler(fixture);const text=extracted.text;
 assert.throws(()=>parseStructuralScheduleText(text.replace(/B1 clear beam length[^\n]*/i,'')),/required explicit dimensions/i);
 assert.throws(()=>parseStructuralScheduleText(text.replace('61.60 m','62.00 m')),/conflicts with count/i);
 assert.throws(()=>parseStructuralScheduleText(''),/No readable PDF text/i);
});

test('authenticated PDF takeoff persists traceable draft rows and blocks BOQ until engineer review',async()=>{
 const owner=await register('pdf-owner'),viewer=await register('pdf-viewer'),outsider=await register('pdf-outsider');
 const created=await call('pdf-owner','POST','/api/mmc-ai/projects',{name:'Structural PDF Takeoff Pilot',country:'JO',currency:'JOD'});
 assert.equal(created.status,201,JSON.stringify(created.data));const projectId=created.data.project.project_id||created.data.project.id;
 const member=await call('pdf-owner','POST','/api/mmc-ai/projects/'+projectId+'/members',{userId:viewer,role:'viewer'});assert.equal(member.status,201);
 const uploaded=await upload('pdf-owner',projectId,'MMC_AI_Structural_Takeoff_Test.pdf',fixture);assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));
 const docId=uploaded.data.document.id;
 const textResult=await call('pdf-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+docId+'/extract/text',{});
 assert.equal(textResult.status,200,JSON.stringify(textResult.data));assert.match(textResult.data.result.text,/STRUCTURAL ELEMENT SCHEDULE/);assert.equal(textResult.data.result.engine,'poppler-pdftotext-layout-v1');
 const runResponse=await call('pdf-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+docId+'/takeoff/pdf',{});
 assert.equal(runResponse.status,201,JSON.stringify(runResponse.data));const run=runResponse.data.run;
 assert.equal(run.status,'needs_review');assert.equal(run.summary.concrete_m3,12.24);assert.equal(run.summary.rebar_kg,892.78);assert.equal(run.items.length,7);
 assert.equal(run.items[0].quantity,4.05);assert.match(run.items[0].detail.formula,/4 × 1.5/);assert.match(run.items[5].detail.marks[2].mark,/S1-D12-X/);
 const outsiderAttempt=await call('pdf-outsider','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+docId+'/takeoff/pdf',{});assert.equal(outsiderAttempt.status,404);
 const viewerRun=await call('pdf-viewer','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+docId+'/takeoff/pdf',{});assert.equal(viewerRun.status,403);
 const premature=await call('pdf-owner','POST','/api/mmc-ai/projects/'+projectId+'/boq',{description:'F1 footing concrete',unit:'m3',quantity:4.05,rate:80,sourceTakeoffItemId:run.items[0].id});assert.equal(premature.status,409);
 const viewerReview=await call('pdf-viewer','PATCH','/api/mmc-ai/projects/'+projectId+'/takeoff/runs/'+run.id+'/review',{status:'approved'});assert.equal(viewerReview.status,403);
 const approved=await call('pdf-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/takeoff/runs/'+run.id+'/review',{status:'approved'});assert.equal(approved.status,200);assert.equal(approved.data.status,'approved');
 const boq=await call('pdf-owner','POST','/api/mmc-ai/projects/'+projectId+'/boq',{description:'F1 footing concrete',unit:'m3',quantity:4.05,rate:80,sourceTakeoffItemId:run.items[0].id});assert.equal(boq.status,201,JSON.stringify(boq.data));
 const noText=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');const scannedLike=await upload('pdf-owner',projectId,'image-only.pdf',noText);assert.equal(scannedLike.status,201);
 const rejected=await call('pdf-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+scannedLike.data.document.id+'/takeoff/pdf',{});assert.equal(rejected.status,422);
});
