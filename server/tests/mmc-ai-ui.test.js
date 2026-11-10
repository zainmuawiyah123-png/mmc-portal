'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../../webpages/mmc-ai/index.html'),'utf8');
test('MMC AI project documents are uploaded to the selected project',()=>{
 assert.match(html,/\/api\/mmc-ai\/projects\/\x27\+encodeURIComponent\(id\)\+\x27\/documents/);
 assert.match(html,/credentials:\x27same-origin\x27/);
 assert.match(html,/لم يبدأ التحليل الهندسي بعد/);
});
test('MMC AI photo gallery supports project-specific image retrieval and cover selection',()=>{
 assert.match(html,/projectGalleryItems/);
 assert.match(html,/\/images\/\x27\+encodeURIComponent\(item\.id\)\+\x27\/cover/);
 assert.match(html,/projectPhotoFile/);
});
test('MMC AI UI does not claim drawing analysis is already available',()=>{
 assert.match(html,/لم يبدأ التحليل الهندسي بعد/);
 assert.match(html,/المعايرة والقياس الآلي: قيد التطوير/);
});

test('MMC AI includes live project executive dashboard and linked workspaces',()=>{
 assert.match(html,/id="executiveDashboard"/);
 assert.match(html,/\/api\/mmc-ai\/projects\/\x27\+encodeURIComponent\(id\)\+\x27\/dashboard/);
 assert.match(html,/id="riskPanel"/);
 assert.match(html,/\/risks/);
 assert.match(html,/id="claimsPanel"/);
 assert.match(html,/\/contract-events/);
});

test('MMC AI exposes BIM coordination issue workspace without claiming 3D clash engine is live',()=>{
 assert.match(html,/id="bimPanel"/);
 assert.match(html,/\/bim\/issues/);
 assert.match(html,/عرض النموذج ثلاثي الأبعاد وتحليل هندسته واكتشاف التعارضات الآلي لم يُفعّل بعد/);
});

test('MMC AI site photo upload captures caption and construction date',()=>{
 assert.match(html,/id="projectPhotoCaption"/);
 assert.match(html,/id="projectPhotoDate"/);
 assert.match(html,/fd\.append\('caption'/);
 assert.match(html,/fd\.append\('capturedAt'/);
});

test('MMC AI schedule allows project roles to update activity progress and status',()=>{
 assert.match(html,/percentComplete:value,status:status\.value/);
 assert.match(html,/await loadExecutiveDashboard\(id\)/);
 assert.match(html,/الإنجاز والحالة/);
});

test('MMC AI BIM workspace supports secure IFC and GLB model intake',()=>{
 assert.match(html,/id="bimModelFile"/);
 assert.match(html,/\/bim\/models/);
 assert.match(html,/رفع نموذج IFC \/ GLB/);
 assert.match(html,/عرض النموذج ثلاثي الأبعاد وتحليل هندسته/);
});

test('MMC AI offers interactive GLB model preview with protected inline model URL',()=>{
 assert.match(html,/<model-viewer id="bimModelCanvas"/);
 assert.match(html,/download\?inline=1/);
 assert.match(html,/bimViewerClose/);
});

test('MMC AI IFC model pre-inspection is available with clear scope disclosure',()=>{
 assert.match(html,/فحص IFC/);
 assert.ok(html.includes('/inspect'));
 assert.match(html,/ملفات IFC تحفظ وتتاح للتنزيل، وتحويلها إلى نموذج قابل للعرض والتحليل ما زال ضمن تطوير محرك BIM/);
});

test('MMC AI contract events capture event dates and allow status workflow updates',()=>{
 assert.match(html,/id="claimEventDate"/);
 assert.match(html,/eventDate:document\.getElementById\('claimEventDate'\)\.value/);
 assert.match(html,/await loadProjectClaims\(id\)/);
 assert.match(html,/تاريخ الحدث/);
});

test('MMC AI assistant sends project-scoped questions and renders sourced answers',()=>{
 assert.match(html,/id="assistantResponse"/);
 assert.match(html,/\/assistant/);
 assert.match(html,/مصدر الإجابة/);
 assert.match(html,/مساعد بيانات المشروع/);
});

test('MMC AI PDF preflight action is available and explicitly disclaims engineering extraction',()=>{
 assert.ok(html.includes('/preflight/pdf'));
 assert.ok(html.includes('/extract/text'));
 assert.ok(html.includes('استخراج النص'));
 assert.ok(html.includes('مؤشرات الرسم'));
 assert.ok(html.includes('نطاق الإحداثيات الخام'));
 assert.match(html,/فحص PDF/);
 assert.match(html,/لم يتم استخراج النصوص أو المسارات أو الأبعاد أو الكميات/);
});
