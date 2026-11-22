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


test('MMC AI document list exposes a project-scoped PDF vector geometry action and states its measurement limits',()=>{
 assert.ok(html.includes("Extract Vector Geometry (Page 1)"));
 assert.ok(html.includes("/extract/vector-geometry"));
 assert.ok(html.includes("These are drawing-space units only, not metres or square metres."));
});


test('MMC AI dashboard binds KPI cards to live project API values',()=>{
 assert.ok(html.includes('id="metricActiveProjects"'));
 assert.ok(html.includes('id="metricDrawingsAnalyzed"'));
 assert.ok(html.includes('id="metricBoqItems"'));
 assert.ok(html.includes('id="metricEngineeringAlerts"'));
 assert.ok(html.includes('s.drawingsAnalyzed'));
 assert.ok(html.includes('s.vectorAnalysisRuns'));
});


test('MMC AI drawing reader shows first-page native text/vector spatial evidence and candidate-only matching',()=>{
 assert.ok(html.includes('nativeSpatialDimensions'));
 assert.ok(html.includes('nativeSpatialElements'));
 assert.ok(html.includes('spatialCorrelation'));
 assert.ok(html.includes('data.spatialCorrelation||null'));
});

test('drawing reader uses a bounded request timeout and always restores its action state',()=>{assert.match(html,/new AbortController\(\)/);assert.match(html,/setTimeout\(\(\)=>controller\.abort\(\),90000\)/);assert.match(html,/clearTimeout\(timeout\)/);});


test('drawing viewer opens the actual authenticated project PDF or image instead of a static sample',()=>{
 assert.ok(html.includes('id="liveDrawingViewer"'));
 assert.ok(html.includes("Open in Drawing Viewer"));
 assert.ok(html.includes("/download?inline=1"));
 assert.ok(html.includes("Displaying actual project file:"));
 assert.ok(!html.includes('assets/diagram-v1.pdf'));
});
