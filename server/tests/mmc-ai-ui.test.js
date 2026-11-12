'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// Test the exact MMC AI page served by Docker's WEB_ROOT in production.
const webRoot=path.join(__dirname,'../../webpages/technical-proposal-kit_v5');
const html=fs.readFileSync(path.join(webRoot,'mmc-ai/index.html'),'utf8');
const homeAr=fs.readFileSync(path.join(webRoot,'index-ar.html'),'utf8');
const homeEn=fs.readFileSync(path.join(webRoot,'index.html'),'utf8');

test('MMC AI is linked from both production-language home screens',()=>{
 assert.match(homeAr,/href="mmc-ai\/index\.html"/);
 assert.match(homeAr,/بوابة الذكاء الهندسي وإدارة المشاريع/);
 assert.match(homeEn,/href="mmc-ai\/index\.html"/);
 assert.match(homeEn,/MMC AI — Construction Intelligence/);
});

test('MMC AI page exposes Arabic and English language switching',()=>{
 assert.match(html,/<html lang="en" dir="ltr">/);
 assert.match(html,/id="languageToggle"/);
 assert.match(html,/mmc-ai-language-switch/);
 assert.match(html,/'Welcome to MMC AI':'مرحباً بك في MMC AI'/);
});

test('project documents upload to the selected project through the authenticated API',()=>{
 assert.match(html,/id="drawingFile"/);
 assert.match(html,/loadProjectDocuments/);
 assert.match(html,/\/documents/);
 assert.match(html,/credentials:'same-origin'/);
});

test('site photo upload captures caption and construction date',()=>{
 assert.match(html,/id="projectPhotoFile"/);
 assert.match(html,/id="projectPhotoCaption"/);
 assert.match(html,/id="projectPhotoDate"/);
 assert.match(html,/fd\.append\('caption'/);
 assert.match(html,/fd\.append\('capturedAt'/);
});

test('project gallery supports project-scoped images and cover selection',()=>{
 assert.match(html,/projectGalleryItems/);
 assert.match(html,/\/images\//);
 assert.match(html,/\/cover/);
});

test('executive dashboard connects project risks and claims workspaces',()=>{
 assert.match(html,/id="executiveDashboard"/);
 assert.match(html,/loadExecutiveDashboard/);
 assert.match(html,/id="riskPanel"/);
 assert.match(html,/\/risks/);
 assert.match(html,/id="claimsPanel"/);
 assert.match(html,/\/contract-events/);
});

test('BIM workspace supports issues, IFC and GLB uploads, inspection and preview',()=>{
 assert.match(html,/id="bimPanel"/);
 assert.match(html,/\/bim\/issues/);
 assert.match(html,/id="bimModelFile"/);
 assert.match(html,/id="bimModelUpload"/);
 assert.match(html,/\/bim\/models/);
 assert.match(html,/\/inspect/);
 assert.match(html,/<model-viewer id="bimModelCanvas"/);
 assert.match(html,/download\?inline=1/);
 assert.match(html,/id="bimViewerClose"/);
});

test('project schedule updates progress and refreshes executive indicators',()=>{
 assert.match(html,/percentComplete:value,status:status\.value/);
 assert.match(html,/loadExecutiveDashboard\(id\)/);
});

test('contract events capture the event date and refresh project claims',()=>{
 assert.match(html,/id="claimEventDate"/);
 assert.match(html,/eventDate:document\.getElementById\('claimEventDate'\)\.value/);
 assert.match(html,/loadProjectClaims\(id\)/);
});

test('project assistant renders answers with their source records',()=>{
 assert.match(html,/id="assistantResponse"/);
 assert.match(html,/\/assistant/);
 assert.match(html,/Answer sources:/);
});

test('PDF preflight and preliminary text extraction are separate actions',()=>{
 assert.match(html,/preflight\/pdf/);
 assert.match(html,/extract\/text/);
 assert.match(html,/PDF Preflight/);
 assert.match(html,/Extract Text/);
 assert.match(html,/Drawing indicators:/);
 assert.match(html,/Raw PDF coordinate range:/);
 assert.match(html,/This check validates file integrity only/);
});

test('complete project data register supports search, audit sections and JSON export',()=>{
 assert.match(html,/id="allProjectDataPanel"/);
 assert.match(html,/id="allProjectDataSearch"/);
 assert.match(html,/id="allProjectDataSections"/);
 assert.match(html,/id="exportAllProjectData"/);
 assert.match(html,/mmc-ai-project-data\.json/);
 assert.match(html,/auditLog:'Audit Log'/);
 assert.match(html,/document\.createElement\('details'\)/);
 assert.match(html,/document\.createElement\('pre'\)/);
});

test('plans modal is beside the language switch and preserves approved subscription choices',()=>{
 assert.match(html,/id="openPlans"/);
 assert.match(html,/id="plansDialog"/);
 assert.match(html,/id="languageToggle"/);
 assert.match(html,/id="selectFreePlan"/);
 assert.match(html,/Choose exactly two activities/);
 assert.match(html,/id="selectProPlan"/);
 assert.match(html,/\$30/);
 assert.match(html,/payment collection, account entitlement enforcement and automatic activation are not connected yet/i);
});

test('DXF takeoff viewer exposes native layer summaries and per-layer visibility filters',()=>{
 assert.match(html,/Drawing Layers — Native DXF/);
 assert.match(html,/takeoff\/runs\/'\+encodeURIComponent\(result\.run\.id\)\+'\/layers/);
 assert.match(html,/toggle\.addEventListener\('change'/);
 assert.match(html,/Engineering discipline is not guessed from layer names/);
});
