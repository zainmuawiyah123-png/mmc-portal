'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mmc-consulting-test-'));
process.env.NODE_ENV='test';
process.env.DB_PATH=path.join(TMP,'test.db');
process.env.UPLOAD_DIR=path.join(TMP,'uploads');
process.env.JWT_SECRET='consulting-test-secret-not-production';
process.env.BCRYPT_ROUNDS='4';
const {migrate}=require('../src/migrate');
const {createApp}=require('../src/index');
const {getDB,closeDB,uid}=require('../src/db');
const Auth=require('../src/lib/auth');
let server,base;const sessions={};
async function call(key,method,url,{body,headers}={}){
 const h=Object.assign({},headers||{});if(sessions[key])h.Cookie=sessions[key];
 let payload;if(body!==undefined){h['Content-Type']='application/json';payload=JSON.stringify(body);}
 const r=await fetch(base+url,{method,headers:h,body:payload,redirect:'manual'});
 const cookies=r.headers.getSetCookie?r.headers.getSetCookie():[];
 for(const c of cookies){const first=c.split(';')[0];if(first.startsWith('tpkit_session='))sessions[key]=first;}
 const type=r.headers.get('content-type')||'';return {status:r.status,data:type.includes('application/json')?await r.json():await r.text(),headers:r.headers};
}
const unique=()=>Math.random().toString(36).slice(2,10);
async function register(key,role){return call(key,'POST','/api/auth/register',{body:{name:'Consulting Test '+key,email:key+'-'+unique()+'@example.test',password:'Password123',company:'Test firm',role,country:'JO'}});}
test.before(async()=>{migrate(process.env.DB_PATH);const app=createApp();await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;resolve();});});});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));closeDB();fs.rmSync(TMP,{recursive:true,force:true});});
test('consulting migrations are additive and idempotent',()=>{const db=getDB();for(const t of ['consulting_firms','consulting_firm_members','consulting_firm_verification_events'])assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));migrate(process.env.DB_PATH).close();});
test('consultant registration receives free base without an automatic trial',async()=>{const r=await register('firmOwner','consultant');assert.equal(r.status,201);assert.equal(r.data.user.planKey,'free');const sub=getDB().prepare('SELECT source,plan_key FROM subscriptions WHERE user_id=?').get(r.data.user.id);assert.equal(sub.source,'system');assert.equal(sub.plan_key,'free');});
test('firm onboarding is isolated by legal identity and tenant',async()=>{const owner=await call('firmOwner','GET','/api/consulting/me');assert.equal(owner.status,200);assert.equal(owner.data.firm,null);const created=await call('firmOwner','POST','/api/consulting/firms',{body:{legalName:'Engineering Consultants LLC',country:'JO',registrationNumber:'REG-2026-001',contactEmail:'office@example.test',contactPhone:'+962790000001',specializations:['Infrastructure','Structural'],experienceSummary:'Infrastructure design and supervision'}});assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.firm.verificationStatus,'pending');const own=await call('firmOwner','GET','/api/consulting/me');assert.equal(own.data.firm.legalName,'Engineering Consultants LLC');const other=await register('otherFirm','consultant');assert.equal(other.status,201);const duplicate=await call('otherFirm','POST','/api/consulting/firms',{body:{legalName:'Duplicate Firm',country:'JO',registrationNumber:'reg 2026-001',contactEmail:'other@example.test',contactPhone:'+962790000002'}});assert.equal(duplicate.status,409);const isolated=await call('otherFirm','GET','/api/consulting/me');assert.equal(isolated.data.firm,null);});
test('non-consultant users cannot create consulting firms',async()=>{const r=await register('contractorUser','contractor');assert.equal(r.status,201);const denied=await call('contractorUser','POST','/api/consulting/firms',{body:{legalName:'No Access Ltd',country:'JO',registrationNumber:'NA-100',contactEmail:'no@example.test',contactPhone:'+962790000003'}});assert.equal(denied.status,403);});
test('consulting portal page is protected and separate from evaluator page',async()=>{const anon=await call('anon','GET','/consulting/');assert.equal(anon.status,302);const denied=await call('contractorUser','GET','/consulting/');assert.equal(denied.status,403);const allowed=await call('firmOwner','GET','/consulting/');assert.equal(allowed.status,200);assert.match(allowed.data,/بوابة المكاتب الاستشارية/);const evaluator=await call('firmOwner','GET','/api/committee/my-assignments');assert.equal(evaluator.status,200);});
test('consulting verification is admin-only and auditable',async()=>{const db=getDB(),adminId=uid('usr_'),hash=await Auth.hashPassword('AdminPassword123');db.prepare("INSERT INTO users (id,email,password_hash,name,role,country,plan_key) VALUES (?,?,?,?,?,?, 'free')").run(adminId,'consulting-admin@example.test',hash,'Consulting Admin','admin','JO');const login=await call('adminUser','POST','/api/auth/login',{body:{email:'consulting-admin@example.test',password:'AdminPassword123'}});assert.equal(login.status,200);const firm=db.prepare('SELECT id FROM consulting_firms LIMIT 1').get();const nonAdmin=await call('firmOwner','PATCH','/api/consulting/admin/firms/'+firm.id+'/verification',{body:{status:'verified'}});assert.equal(nonAdmin.status,403);const approved=await call('adminUser','PATCH','/api/consulting/admin/firms/'+firm.id+'/verification',{body:{status:'verified',note:'تمت مطابقة المستندات القانونية'}});assert.equal(approved.status,200);const own=await call('firmOwner','GET','/api/consulting/me');assert.equal(own.data.firm.verificationStatus,'verified');const events=db.prepare('SELECT action FROM consulting_firm_verification_events WHERE firm_id=? ORDER BY created_at,id').all(firm.id).map(x=>x.action);assert.ok(events.includes('submitted'));assert.ok(events.includes('verified'));});
test('consultant billing cannot fall through to contractor plans or invoices',async()=>{const plans=await call('firmOwner','GET','/api/billing/plans?audience=consultant');assert.equal(plans.status,200);assert.deepEqual(plans.data.plans,[]);assert.equal(plans.data.consultantProfessional.priceMonth,20);assert.equal(plans.data.consultantProfessional.currency,'USD');const consultantDefaultPlans=await call('firmOwner','GET','/api/billing/plans');assert.deepEqual(consultantDefaultPlans.data.plans,[]);const publicContractorPlans=await call('anon','GET','/api/billing/plans');assert.ok(publicContractorPlans.data.plans.length>0);const trial=await call('firmOwner','POST','/api/billing/trial',{body:{planKey:'pro'}});assert.equal(trial.status,403);const invoice=await call('firmOwner','POST','/api/billing/invoices',{body:{planKey:'pro',billingCycle:'monthly',currency:'USD'}});assert.equal(invoice.status,403);});

test('consulting marketplace isolates requester, proposals, award and contract between firms',async()=>{
 const buyer=await register('requesterBuyer','buyer');assert.equal(buyer.status,201);const requesterPage=await call('requesterBuyer','GET','/consulting/requester/');assert.equal(requesterPage.status,200);const contractorPage=await call('contractorUser','GET','/consulting/requester/');assert.equal(contractorPage.status,403);
 const entity=await call('requesterBuyer','POST','/api/consulting/requester/entities',{body:{legalName:'Independent Project Owner LLC',country:'JO',registrationNumber:'BUYER-REG-2201',contactEmail:'owner@example.test',contactPhone:'+962790000101'}});
 assert.equal(entity.status,201,JSON.stringify(entity.data));const entityId=entity.data.requester.id;
 const pending=await call('adminUser','PATCH','/api/consulting/admin/requesters/'+entityId+'/verification',{body:{status:'verified',note:'تمت مطابقة رقم تسجيل الجهة في السجل الرسمي'}});
 assert.equal(pending.status,200);
 const req=await call('requesterBuyer','POST','/api/consulting/requests',{body:{title:'Structural and infrastructure design services',discipline:'Civil Engineering',country:'JO',location:'Amman',description:'Design review, structural calculations and infrastructure engineering supervision for a mixed-use development.',scope:['Structural design review','Infrastructure drawings','Site supervision'],currency:'USD',budgetMin:18000,budgetMax:30000,closingDate:'2099-01-01'}});
 assert.equal(req.status,201,JSON.stringify(req.data));const requestId=req.data.request.id;
 const second=await register('secondConsultant','consultant');assert.equal(second.status,201);
 const secondFirm=await call('secondConsultant','POST','/api/consulting/firms',{body:{legalName:'Second Engineering Office',country:'SA',registrationNumber:'SA-REG-9022',contactEmail:'office2@example.test',contactPhone:'+966500000202',specializations:['Structural']}});assert.equal(secondFirm.status,201,JSON.stringify(secondFirm.data));
 const firmId=secondFirm.data.firm.id;
 const verifyFirm=await call('adminUser','PATCH','/api/consulting/admin/firms/'+firmId+'/verification',{body:{status:'verified',note:'تمت مطابقة رقم التسجيل في السجل التجاري'}});
 assert.equal(verifyFirm.status,200);
 const feed=await call('firmOwner','GET','/api/consulting/requests/open');assert.equal(feed.status,200);assert.ok(feed.data.requests.some(x=>x.id===requestId));
 const proposalA=await call('firmOwner','POST','/api/consulting/requests/'+requestId+'/proposals',{body:{technicalSummary:'We propose a qualified civil engineering team with relevant infrastructure and building design experience.',methodology:'Review design criteria, perform calculations, issue coordinated drawings and supervise site implementation.',teamSummary:'Project director, structural engineer, infrastructure engineer and site inspector.',financialAmount:24000,currency:'USD',durationDays:120,validityUntil:'2099-02-01'}});
 assert.equal(proposalA.status,201,JSON.stringify(proposalA.data));
 const proposalB=await call('secondConsultant','POST','/api/consulting/requests/'+requestId+'/proposals',{body:{technicalSummary:'Our multidisciplinary office will deliver structural design review and infrastructure engineering services.',methodology:'Kickoff, design audit, technical submissions, coordination and supervision reporting.',teamSummary:'Technical manager, two design engineers and resident inspector.',financialAmount:22500,currency:'USD',durationDays:135}});
 assert.equal(proposalB.status,201,JSON.stringify(proposalB.data));
 const hiddenA=await call('firmOwner','GET','/api/consulting/requests/'+requestId+'/proposals');assert.equal(hiddenA.status,403);
 const mineA=await call('firmOwner','GET','/api/consulting/proposals/mine');assert.equal(mineA.status,200);assert.equal(mineA.data.proposals.length,1);assert.equal(mineA.data.proposals[0].id,proposalA.data.proposal.id);
 const mineB=await call('secondConsultant','GET','/api/consulting/proposals/mine');assert.equal(mineB.status,200);assert.equal(mineB.data.proposals.length,1);assert.equal(mineB.data.proposals[0].id,proposalB.data.proposal.id);
 const ownerView=await call('requesterBuyer','GET','/api/consulting/requests/'+requestId+'/proposals');assert.equal(ownerView.status,200);assert.equal(ownerView.data.proposals.length,2);
 const awarded=await call('requesterBuyer','POST','/api/consulting/requests/'+requestId+'/award',{body:{proposalId:proposalA.data.proposal.id,contractReference:'CONS-TEST-001'}});assert.equal(awarded.status,201,JSON.stringify(awarded.data));
 const contractA=await call('firmOwner','GET','/api/consulting/contracts');assert.equal(contractA.status,200);assert.equal(contractA.data.contracts.length,1);assert.equal(contractA.data.contracts[0].contract_reference,'CONS-TEST-001');
 const contractB=await call('secondConsultant','GET','/api/consulting/contracts');assert.equal(contractB.status,200);assert.equal(contractB.data.contracts.length,0);
 const contractBuyer=await call('requesterBuyer','GET','/api/consulting/contracts');assert.equal(contractBuyer.status,200);assert.equal(contractBuyer.data.contracts.length,1);
 const finalProposals=await call('requesterBuyer','GET','/api/consulting/requests/'+requestId+'/proposals');assert.equal(finalProposals.data.proposals.find(x=>x.id===proposalA.data.proposal.id).status,'selected');assert.equal(finalProposals.data.proposals.find(x=>x.id===proposalB.data.proposal.id).status,'rejected');
});
