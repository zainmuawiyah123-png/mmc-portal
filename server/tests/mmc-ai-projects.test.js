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
async function upload(user,projectId,name,bytes){
 const form=new FormData();form.append('file',new Blob([bytes]),name);
 const r=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/documents',{method:'POST',headers:{...(jar[user]?{Cookie:jar[user]}:{})},body:form});
 const data=(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text();
 return {status:r.status,data};
}
async function uploadBimModel(user,projectId,name,bytes,fields={}){
 const form=new FormData();form.append('file',new Blob([bytes]),name);for(const [k,v] of Object.entries(fields))form.append(k,String(v));
 const r=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/bim/models',{method:'POST',headers:{...(jar[user]?{Cookie:jar[user]}:{})},body:form});
 const data=(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text();return {status:r.status,data};
}
async function uploadImage(user,projectId,name,bytes,fields={}){
 const form=new FormData();form.append('file',new Blob([bytes]),name);
 for(const [k,v] of Object.entries(fields))form.append(k,String(v));
 const r=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/images',{method:'POST',headers:{...(jar[user]?{Cookie:jar[user]}:{})},body:form});
 const data=(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text();
 return {status:r.status,data};
}
async function register(key){const r=await call(key,'POST','/api/auth/register',{name:key,email:key+uniq()+'@test.local',password:'Password123',company:key});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.user.id;}
test.before(async()=>{
 migrate(process.env.DB_PATH);
 const app=createApp();
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;resolve();});});
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));closeDB();fs.rmSync(TMP,{recursive:true,force:true});});

test('staging access gate fails closed and requires valid HTTP Basic credentials',async()=>{
 const previous={required:process.env.STAGING_BASIC_AUTH_REQUIRED,user:process.env.STAGING_BASIC_AUTH_USER,password:process.env.STAGING_BASIC_AUTH_PASSWORD};
 try{
  process.env.STAGING_BASIC_AUTH_REQUIRED='true';
  delete process.env.STAGING_BASIC_AUTH_USER;
  delete process.env.STAGING_BASIC_AUTH_PASSWORD;
  const locked=await fetch(base+'/api/health');
  assert.equal(locked.status,503);
  process.env.STAGING_BASIC_AUTH_USER='mmc-staging-test';
  process.env.STAGING_BASIC_AUTH_PASSWORD='test-only-password-123';
  const anonymous=await fetch(base+'/api/health');
  assert.equal(anonymous.status,401);
  assert.match(anonymous.headers.get('www-authenticate')||'',/Basic realm="MMC AI staging"/);
  const invalid=await fetch(base+'/api/health',{headers:{Authorization:'Basic '+Buffer.from('mmc-staging-test:wrong-password').toString('base64')}});
  assert.equal(invalid.status,401);
  const authorized=await fetch(base+'/api/health',{headers:{Authorization:'Basic '+Buffer.from('mmc-staging-test:test-only-password-123').toString('base64')}});
  assert.equal(authorized.status,200);
 }finally{
  if(previous.required===undefined)delete process.env.STAGING_BASIC_AUTH_REQUIRED;else process.env.STAGING_BASIC_AUTH_REQUIRED=previous.required;
  if(previous.user===undefined)delete process.env.STAGING_BASIC_AUTH_USER;else process.env.STAGING_BASIC_AUTH_USER=previous.user;
  if(previous.password===undefined)delete process.env.STAGING_BASIC_AUTH_PASSWORD;else process.env.STAGING_BASIC_AUTH_PASSWORD=previous.password;
 }
});

test('MMC AI and administration HTML routes enforce authentication before static file serving',async()=>{
 const anonymousMmc=await fetch(base+'/mmc-ai/index.html',{redirect:'manual'});
 assert.equal(anonymousMmc.status,302);
 assert.match(anonymousMmc.headers.get('location')||'',/login\.html/);
 const anonymousAdmin=await fetch(base+'/admin/index.html',{redirect:'manual'});
 assert.equal(anonymousAdmin.status,302);
 assert.match(anonymousAdmin.headers.get('location')||'',/login\.html/);
 await register('ai-page-security');
 const memberMmc=await call('ai-page-security','GET','/mmc-ai/index.html');
 assert.equal(memberMmc.status,200);
 const memberAdmin=await call('ai-page-security','GET','/admin/index.html');
 assert.equal(memberAdmin.status,403);
});

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
 const viewerUpload=await upload('ai-viewer',projectId,'plan.pdf',Buffer.from('%PDF-1.4\n%%EOF'));
 assert.equal(viewerUpload.status,403);
 const badPdf=await upload('ai-owner',projectId,'fake.pdf',Buffer.from('not a pdf'));
 assert.equal(badPdf.status,422);
 const goodPdf=await upload('ai-owner',projectId,'structural-plan.pdf',Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Length 23 >>\nstream\nBT (MMC PDF Text) Tj ET\nendstream\nendobj\n%%EOF'));
 assert.equal(goodPdf.status,201,JSON.stringify(goodPdf.data));

 assert.equal(goodPdf.data.document.file_ext,'.pdf');
 const pdfPreflight=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+goodPdf.data.document.id+'/preflight/pdf',{});
 assert.equal(pdfPreflight.status,200,JSON.stringify(pdfPreflight.data));
 assert.equal(pdfPreflight.data.report.status,'preflight_passed');
 assert.equal(pdfPreflight.data.report.extractionReady,false);
 assert.equal(pdfPreflight.data.report.analysisStatus,'parser_not_configured');
 assert.match(pdfPreflight.data.notice,/لا يستخرج النصوص أو الأبعاد أو الكميات/);
 const pdfText=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+goodPdf.data.document.id+'/extract/text',{});
 assert.equal(pdfText.status,200,JSON.stringify(pdfText.data));
 assert.equal(pdfText.data.result.status,'partial_text_extracted');
 assert.match(pdfText.data.result.text,/MMC PDF Text/);
 assert.match(pdfText.data.notice,/لا يمثل OCR أو تحليلاً هندسياً/);
 const outsiderPdfText=await call('ai-outsider','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+goodPdf.data.document.id+'/extract/text',{});
 assert.equal(outsiderPdfText.status,404);
 const outsiderPdfPreflight=await call('ai-outsider','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+goodPdf.data.document.id+'/preflight/pdf',{});
 assert.equal(outsiderPdfPreflight.status,404);

 const dxfText=['0','SECTION','2','HEADER','9','$INSUNITS','70','6','0','ENDSEC','0','SECTION','2','ENTITIES','0','LINE','8','EARTHWORK','10','0','20','0','11','3','21','4','0','ENDSEC','0','EOF'].join('\n');
 const dxfUpload=await upload('ai-owner',projectId,'site-plan.dxf',Buffer.from(dxfText));
 assert.equal(dxfUpload.status,201,JSON.stringify(dxfUpload.data));
 const dxfRun=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+dxfUpload.data.document.id+'/takeoff/dxf',{});
 assert.equal(dxfRun.status,201,JSON.stringify(dxfRun.data));
 assert.equal(dxfRun.data.run.status,'needs_review');
 assert.equal(dxfRun.data.run.summary.supportedEntities,1);
 assert.equal(dxfRun.data.run.items[0].quantity,5);
 const viewerReview=await call('ai-viewer','PATCH','/api/mmc-ai/projects/'+projectId+'/takeoff/runs/'+dxfRun.data.run.id+'/review',{status:'approved'});
 assert.equal(viewerReview.status,403);
 const storedRun=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/takeoff/runs/'+dxfRun.data.run.id);
 assert.equal(storedRun.status,200);assert.equal(storedRun.data.items.length,1);
 const prematureBoq=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/boq',{description:'Unapproved excavation',unit:'m3',quantity:5,rate:3,sourceTakeoffItemId:dxfRun.data.run.items[0].id});assert.equal(prematureBoq.status,409);
 const approved=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/takeoff/runs/'+dxfRun.data.run.id+'/review',{status:'approved'});
 assert.equal(approved.status,200);assert.equal(approved.data.status,'approved');
 const runs=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/takeoff/runs');
 assert.equal(runs.status,200);assert.equal(runs.data.runs.length,1);
 const boqAdd=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/boq',{itemCode:'EW-001',description:'Measured earthworks line',unit:'m',quantity:5,rate:3.25,sourceTakeoffItemId:dxfRun.data.run.items[0].id});
 assert.equal(boqAdd.status,201,JSON.stringify(boqAdd.data));
 assert.equal(boqAdd.data.item.line_total,16.25);assert.equal(boqAdd.data.item.source_takeoff_item_id,dxfRun.data.run.items[0].id);
 const boqViewer=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/boq',{description:'Not allowed',unit:'m3',quantity:1,rate:1});
 assert.equal(boqViewer.status,403);
 const boqList=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/boq');
 assert.equal(boqList.status,200);assert.equal(boqList.data.items.length,1);assert.equal(boqList.data.summary.total,16.25);
 const sourceRef=boqList.data.items[0].sourceReference;
 assert.ok(sourceRef,'BOQ item should expose its linked takeoff source');
 assert.equal(sourceRef.takeoffItemId,dxfRun.data.run.items[0].id);
 assert.equal(sourceRef.entityType,'LINE');assert.equal(sourceRef.nativeCadLayer,'EARTHWORK');
 assert.equal(sourceRef.runId,dxfRun.data.run.id);assert.equal(sourceRef.runStatus,'approved');
 assert.equal(sourceRef.documentId,dxfUpload.data.document.id);assert.equal(sourceRef.documentName,'site-plan.dxf');
 assert.equal(sourceRef.quantity,5);assert.equal(sourceRef.unit,'m');
 const boqQuantityChange=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/boq/'+boqAdd.data.item.id,{quantity:130});assert.equal(boqQuantityChange.status,422);
 const boqUpdate=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/boq/'+boqAdd.data.item.id,{rate:4});
 assert.equal(boqUpdate.status,200);assert.equal(boqUpdate.data.item.line_total,20);
 const boqOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/boq');
 assert.equal(boqOutsider.status,404);
 const boqDelete=await call('ai-owner','DELETE','/api/mmc-ai/projects/'+projectId+'/boq/'+boqAdd.data.item.id,{});
 assert.equal(boqDelete.status,200);
 const boqEmpty=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/boq');
 assert.equal(boqEmpty.data.summary.total,0);
 const taskA=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/schedule/tasks',{name:'Excavation',durationDays:5,plannedStart:'2026-11-12'});
 assert.equal(taskA.status,201,JSON.stringify(taskA.data));
 const taskB=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/schedule/tasks',{name:'Foundations',durationDays:3,predecessors:[taskA.data.task.id]});
 assert.equal(taskB.status,201,JSON.stringify(taskB.data));
 const taskC=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/schedule/tasks',{name:'Site utilities',durationDays:2,predecessors:[taskA.data.task.id]});
 assert.equal(taskC.status,201,JSON.stringify(taskC.data));
 const taskD=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/schedule/tasks',{name:'Superstructure',durationDays:4,predecessors:[taskB.data.task.id,taskC.data.task.id]});
 assert.equal(taskD.status,201,JSON.stringify(taskD.data));
 const taskProgressA=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/schedule/tasks/'+taskA.data.task.id,{percentComplete:50,status:'in_progress',actualStart:'2026-11-12'});assert.equal(taskProgressA.status,200);
 const taskProgressB=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/schedule/tasks/'+taskB.data.task.id,{percentComplete:100,status:'completed',actualStart:'2026-11-17',actualFinish:'2026-11-19'});assert.equal(taskProgressB.status,200);
 const schedule=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/schedule');
 assert.equal(schedule.status,200);assert.equal(schedule.data.analysis.projectDurationWorkingDays,12);
 assert.equal(schedule.data.analysis.criticalTaskCount,3);
 const cycle=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/schedule/tasks/'+taskB.data.task.id,{predecessors:[taskD.data.task.id]});
 assert.equal(cycle.status,422);
 const viewerSchedule=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/schedule/tasks',{name:'Unauthorized',durationDays:1});
 assert.equal(viewerSchedule.status,403);
 const outsiderSchedule=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/schedule');
 assert.equal(outsiderSchedule.status,404);
 const dependentDelete=await call('ai-owner','DELETE','/api/mmc-ai/projects/'+projectId+'/schedule/tasks/'+taskA.data.task.id,{});
 assert.equal(dependentDelete.status,409);
 const bimCreate=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/bim/issues',{title:'HVAC duct clashes with beam',modelReference:'Coordination model v03',discipline:'mechanical',severity:'high',description:'Duct route intersects structural beam at grid B-4.',elementIds:['DUCT-004','BEAM-B4'],proposedResolution:'Review alternative duct elevation with structural engineer.'});
 assert.equal(bimCreate.status,201,JSON.stringify(bimCreate.data));assert.deepEqual(bimCreate.data.issue.element_ids,['DUCT-004','BEAM-B4']);
 const badBimModel=await uploadBimModel('ai-owner',projectId,'broken.ifc',Buffer.from('not an IFC model'));assert.equal(badBimModel.status,422);
 const viewerBimModel=await uploadBimModel('ai-viewer',projectId,'model.ifc',Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;'));assert.equal(viewerBimModel.status,403);
 const ifcBytes=Buffer.from('ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'ViewDefinition [CoordinationView]\'),\'2;1\');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;');
 const ifcModel=await uploadBimModel('ai-owner',projectId,'coordination.ifc',ifcBytes,{modelReference:'IFC-COORD-R01',discipline:'structural'});assert.equal(ifcModel.status,201,JSON.stringify(ifcModel.data));assert.equal(ifcModel.data.model.model_format,'ifc');
 const modelList=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/bim/models');assert.equal(modelList.status,200);assert.equal(modelList.data.summary.ifc,1);
 const modelDownload=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/bim/models/'+ifcModel.data.model.id+'/download',{headers:{Cookie:jar['ai-owner']}});assert.equal(modelDownload.status,200);assert.deepEqual(Buffer.from(await modelDownload.arrayBuffer()),ifcBytes);
  const inspectBytes=Buffer.from(`ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#2=IFCPROJECT('project-guid',$,'Test project',$,$,$,$,$,$);\n#3=IFCWALL('wall-guid',$,'External wall',$,$,$,$,$);\n#4=IFCSLAB('slab-guid',$,'Ground slab',$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;`);
 const inspectModel=await uploadBimModel('ai-owner',projectId,'inspection.ifc',inspectBytes,{modelReference:'IFC-INSPECT-01'});assert.equal(inspectModel.status,201,JSON.stringify(inspectModel.data));
 const inspect=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/bim/models/'+inspectModel.data.model.id+'/inspect');assert.equal(inspect.status,200,JSON.stringify(inspect.data));assert.equal(inspect.data.inspection.schema,'IFC4');assert.equal(inspect.data.inspection.buildingElementCount,2);assert.equal(inspect.data.inspection.lengthUnit,'m');assert.equal(inspect.data.inspection.records,4);
 const inspectOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/bim/models/'+inspectModel.data.model.id+'/inspect');assert.equal(inspectOutsider.status,404);

 const modelOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/bim/models');assert.equal(modelOutsider.status,404); const glbBytes=Buffer.alloc(12);glbBytes.write('glTF',0,'ascii');glbBytes.writeUInt32LE(2,4);glbBytes.writeUInt32LE(12,8);
 const glbModel=await uploadBimModel('ai-owner',projectId,'coordination.glb',glbBytes,{modelReference:'GLB-COORD-R01'});assert.equal(glbModel.status,201,JSON.stringify(glbModel.data));assert.equal(glbModel.data.model.model_format,'glb');
 const modelList2=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/bim/models');assert.equal(modelList2.data.summary.glb,1);
 const glbPreview=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/bim/models/'+glbModel.data.model.id+'/download?inline=1',{headers:{Cookie:jar['ai-owner']}});assert.equal(glbPreview.status,200);assert.match(glbPreview.headers.get('content-disposition'),/^inline;/);assert.deepEqual(Buffer.from(await glbPreview.arrayBuffer()),glbBytes);

 const bimList=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/bim/issues');assert.equal(bimList.status,200);assert.equal(bimList.data.summary.high,1);
 const bimViewer=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/bim/issues',{title:'Viewer not permitted',description:'This should be rejected'});assert.equal(bimViewer.status,403);
 const bimUpdate=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/bim/issues/'+bimCreate.data.issue.id,{status:'resolved'});assert.equal(bimUpdate.status,200);assert.equal(bimUpdate.data.issue.status,'resolved');
 const bimOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/bim/issues');assert.equal(bimOutsider.status,404);
 const riskCreate=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/risks',{title:'Unexpected groundwater',category:'technical',description:'Groundwater level higher than the design assumption.',probability:4,impact:5,mitigation:'Conduct pumping trial and submit revised method statement.'});
 assert.equal(riskCreate.status,201,JSON.stringify(riskCreate.data));assert.equal(riskCreate.data.risk.score,20);assert.equal(riskCreate.data.risk.level,'critical');
 const riskList=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/risks');assert.equal(riskList.status,200);assert.equal(riskList.data.summary.critical,1);
 const riskViewer=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/risks',{title:'Not allowed',description:'Viewer cannot add risks',probability:1,impact:1});assert.equal(riskViewer.status,403);
 const riskUpdate=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/risks/'+riskCreate.data.risk.id,{probability:2,impact:2,status:'mitigating'});assert.equal(riskUpdate.status,200);assert.equal(riskUpdate.data.risk.score,4);
 const riskOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/risks');assert.equal(riskOutsider.status,404);
 const eventCreate=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/contract-events',{title:'Late access to work area',fidicClause:'8.4',noticeDate:'2026-11-10',eventDate:'2026-11-09',particulars:'The work area was not handed over on the agreed date; site records and correspondence retained.',timeImpactDays:12,costImpact:8500,currency:'JOD'});
 assert.equal(eventCreate.status,201,JSON.stringify(eventCreate.data));assert.equal(eventCreate.data.event.fidic_clause,'8.4');assert.equal(eventCreate.data.event.event_date,'2026-11-09');
 const eventList=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/contract-events');assert.equal(eventList.status,200);assert.equal(eventList.data.summary.timeImpactDays,12);assert.equal(eventList.data.summary.costImpact,8500);
 const invalidEventDate=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/contract-events',{title:'Invalid date event',particulars:'This test must reject an invalid event date.',eventDate:'2026-02-30'});assert.equal(invalidEventDate.status,422);
 const eventViewer=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/contract-events',{title:'Not allowed',particulars:'Viewer cannot submit contractual events'});assert.equal(eventViewer.status,403);
 const eventUpdate=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/contract-events/'+eventCreate.data.event.id,{status:'notice_sent'});assert.equal(eventUpdate.status,200);assert.equal(eventUpdate.data.event.status,'notice_sent');
 const eventOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/contract-events');assert.equal(eventOutsider.status,404);
 const assistantRisk=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/assistant',{question:'ما هي المخاطر الحالية؟'});assert.equal(assistantRisk.status,200);assert.match(assistantRisk.data.assistant.answer,/groundwater|مخاطر|خطر/i);assert.equal(assistantRisk.data.assistant.sources[0].type,'risk_register');assert.match(assistantRisk.data.assistant.limitations,/ليست نموذجاً لغوياً توليدياً/);
 const assistantCost=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/assistant',{question:'ما هي تكلفة BOQ؟'});assert.equal(assistantCost.status,200);assert.equal(assistantCost.data.assistant.sources[0].type,'boq');
 const assistantViewer=await call('ai-viewer','POST','/api/mmc-ai/projects/'+projectId+'/assistant',{question:'لخص المشروع'});assert.equal(assistantViewer.status,200);
 const assistantOutsider=await call('ai-outsider','POST','/api/mmc-ai/projects/'+projectId+'/assistant',{question:'لخص المشروع'});assert.equal(assistantOutsider.status,404);
 const assistantEmpty=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/assistant',{question:' '});assert.equal(assistantEmpty.status,422);

 const executive=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/dashboard');
 assert.equal(executive.status,200);assert.equal(executive.data.summary.boqItems,0);assert.equal(executive.data.summary.scheduleTasks,4);assert.equal(executive.data.summary.averageTaskProgress,39.3);assert.equal(executive.data.summary.completedTasks,1);assert.equal(executive.data.summary.inProgressTasks,1);assert.equal(executive.data.summary.criticalRisks,0);assert.equal(executive.data.summary.bimIssues,1);assert.equal(executive.data.summary.openBimIssues,0);assert.equal(executive.data.summary.criticalBimIssues,0);assert.equal(executive.data.summary.contractEvents,1);assert.equal(executive.data.summary.documents,2);assert.equal(executive.data.summary.sitePhotos,0);
 const executiveOutsider=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/dashboard');assert.equal(executiveOutsider.status,404);

 const pdfTakeoff=await call('ai-owner','POST','/api/mmc-ai/projects/'+projectId+'/documents/'+goodPdf.data.document.id+'/takeoff/dxf',{});
 assert.equal(pdfTakeoff.status,422);
 const docs=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/documents');
 assert.equal(docs.status,200);assert.equal(docs.data.documents.length,2);
 const docId=goodPdf.data.document.id;
 const ownerDownload=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/documents/'+docId+'/download',{headers:{Cookie:jar['ai-owner']}});
 assert.equal(ownerDownload.status,200);
 assert.equal(ownerDownload.headers.get('content-length'),String(goodPdf.data.document.size_bytes));
 assert.match(await ownerDownload.text(),/^%PDF-1\.4/);
 const viewerDownload=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/documents/'+docId+'/download',{headers:{Cookie:jar['ai-viewer']}});
 assert.equal(viewerDownload.status,200);

 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 const viewerImage=await uploadImage('ai-viewer',projectId,'site.png',png,{isCover:true});
 assert.equal(viewerImage.status,403);
 const invalidDateImage=await uploadImage('ai-owner',projectId,'invalid-date.png',png,{caption:'تاريخ غير صالح',capturedAt:'2026-02-31'});assert.equal(invalidDateImage.status,422);
 const ownerImage=await uploadImage('ai-owner',projectId,'site-progress.png',png,{isCover:true,caption:'واجهة المشروع أثناء التنفيذ',capturedAt:'2026-11-10'});
 assert.equal(ownerImage.status,201,JSON.stringify(ownerImage.data));
 assert.equal(ownerImage.data.image.is_cover,1);
 const images=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/images');
 assert.equal(images.status,200);assert.equal(images.data.images.length,1);
 assert.equal(images.data.images[0].caption,'واجهة المشروع أثناء التنفيذ');
 const secondImage=await uploadImage('ai-owner',projectId,'site-phase-2.png',png,{caption:'مرحلة تنفيذ ثانية',capturedAt:'2026-11-11'});
 assert.equal(secondImage.status,201,JSON.stringify(secondImage.data));
 assert.equal(secondImage.data.image.is_cover,0);
 const coverChange=await call('ai-owner','PATCH','/api/mmc-ai/projects/'+projectId+'/images/'+secondImage.data.image.id+'/cover',{});
 assert.equal(coverChange.status,200);
 const afterCover=await call('ai-owner','GET','/api/mmc-ai/projects/'+projectId+'/images');
 assert.equal(afterCover.data.images.filter(x=>x.is_cover===1).length,1);
 assert.equal(afterCover.data.images.find(x=>x.is_cover===1).id,secondImage.data.image.id);
 const viewerCoverChange=await call('ai-viewer','PATCH','/api/mmc-ai/projects/'+projectId+'/images/'+ownerImage.data.image.id+'/cover',{});
 assert.equal(viewerCoverChange.status,403);
 const imageDownload=await fetch(base+'/api/mmc-ai/projects/'+projectId+'/images/'+ownerImage.data.image.id+'/download',{headers:{Cookie:jar['ai-owner']}});
 assert.equal(imageDownload.status,200);assert.equal(imageDownload.headers.get('content-type'),'image/png');
 assert.deepEqual(Buffer.from(await imageDownload.arrayBuffer()),png);
 const outsiderImages=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/images');
 assert.equal(outsiderImages.status,404);
 const outsiderImage=await uploadImage('ai-outsider',projectId,'site.png',png,{isCover:true});
 assert.equal(outsiderImage.status,404);

 const outsiderDocs=await call('ai-outsider','GET','/api/mmc-ai/projects/'+projectId+'/documents');
 assert.equal(outsiderDocs.status,404);
 const outsiderUpload=await upload('ai-outsider',projectId,'other.pdf',Buffer.from('%PDF-1.4\n%%EOF'));
 assert.equal(outsiderUpload.status,404);

});
