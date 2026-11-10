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
