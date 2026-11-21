'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../../webpages/technical-proposal-kit_v5/mmc-ai/index.html'),'utf8');

test('MMC AI document list exposes a separate saved drawing text and OCR evidence action',()=>{
 assert.ok(html.includes("drawingRead.textContent='Read Drawing (OCR + Evidence)'"));
 assert.ok(html.includes("/analyze/drawing-text"));
 assert.ok(html.includes("No quantities or 3D model were generated."));
 assert.ok(html.includes("Scale and geometry remain unverified"));
});
