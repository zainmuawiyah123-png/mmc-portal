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

test('BOQ displays project-scoped drawing source traceability and measurement details',()=>{
 assert.match(html,/<th>Source \/ Traceability<\/th>/);
 assert.match(html,/item\.sourceReference/);
 assert.match(html,/nativeCadLayer/);
 assert.match(html,/takeoffItemId/);
 assert.match(html,/Measurement details/);
 assert.match(html,/Manual BOQ item — no drawing source linked/);
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

test('PDF preflight and saved drawing-read actions are separate',()=>{
 assert.match(html,/preflight\/pdf/);
 assert.match(html,/analyze\/drawing-text/);
 assert.match(html,/analysis\/latest/);
 assert.match(html,/PDF Preflight/);
 assert.match(html,/Read Drawing \(PDF\)/);
 assert.match(html,/Load Saved Read/);
 assert.match(html,/Detected dimension candidates/);
 assert.match(html,/Engineering quantity status: NOT CALCULATED/);
});


test('drawing text intelligence action calls the authenticated analysis API and labels results as review-only',()=>{
 assert.match(html,/Analyze Drawing Text/);
 assert.match(html,/\/analyze\/drawing-text/);
 assert.match(html,/method:'POST'/);
 assert.match(html,/credentials:'same-origin'/);
 assert.match(html,/Drawing Text Intelligence — Evidence Review Only/);
 assert.match(html,/quantities are calculated or approved/);
 assert.match(html,/drawing elements, and no quantities are calculated or approved/);
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

test('DXF takeoff UI supports creating user layers and assigning elements to layers',()=>{
 assert.match(html,/New layer name/);
 assert.match(html,/Create Layer/);
 assert.match(html,/takeoff\/runs\/'\+encodeURIComponent\(result\.run\.id\)\+'\/items\/'\+encodeURIComponent\(row\.dataset\.itemId\)\+'\/layer/);
 assert.match(html,/Save layer/);
 assert.match(html,/User: /);
});

test('renders supported DXF geometry in the drawing preview',()=>{
 assert.match(html,/Engineering Drawing Preview/);
 assert.match(html,/DXF geometry preview/);
 assert.match(html,/geometryItems/);
 assert.match(html,/LWPOLYLINE/);
 assert.match(html,/data-item-id/);
 assert.match(html,/Select a row to highlight its source element/);
});

test('selected DXF element inspection exposes source document, takeoff run, and geometry coordinates',()=>{
 assert.match(html,/Element ID/);
 assert.match(html,/Native CAD layer/);
 assert.match(html,/Source document/);
 assert.match(html,/Takeoff run/);
 assert.match(html,/Start \('/);
 assert.match(html,/Center \('/);
 assert.match(html,/Source coordinates are shown in drawing units/);
});

test('supports drawing zoom pan and element inspection',()=>{
 assert.match(html,/Zoom \+/);
 assert.match(html,/Zoom −/);
 assert.match(html,/Fit drawing/);
 assert.match(html,/pointermove/);
 assert.match(html,/wheel/);
 assert.match(html,/selectDrawingItem/);
 assert.match(html,/Source geometry/);
});

test('synchronizes native and user layer visibility with reassigned drawing elements and table rows',()=>{
 assert.match(html,/const layerAssignments=new Map/);
 assert.match(html,/effectiveLayerId/);
 assert.match(html,/syncLayerVisibility/);
 assert.match(html,/layerVisibility\.get\(effectiveLayerId/);
 assert.match(html,/layerVisibility\.set\(layer\.id,toggle\.checked\)/);
 assert.match(html,/allLayers=data\.layers\|\|allLayers/);
 assert.match(html,/renderLayerCard\(created\)/);
});;


test('PDF extraction UI exposes nested API errors and provides a separate Arabic/English OCR action',()=>{
 assert.match(html,/data\.error\?\.message\|\|data\.message\|\|/);
 assert.match(html,/OCR \(Arabic \+ English\)/);
 assert.match(html,/\/ocr\/status/);
 assert.match(html,/\/ocr\/pdf/);
 assert.match(html,/statusData\.runtime\?\.available/);
 assert.match(html,/page\.averageConfidence/);
 assert.match(html,/OCR recognizes visible text only/);
});
