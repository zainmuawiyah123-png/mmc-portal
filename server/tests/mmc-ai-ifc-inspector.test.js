'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {parseIfc}=require('../src/lib/mmc-ai/ifc-inspector');
const fixture="ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#2=IFCPROJECT('project-guid',$,'Test project',$,$,$,$,$,$);\n#3=IFCSITE('site-guid',$,'Main site',$,$,$,$,$,$,$,$,$,$);\n#4=IFCBUILDINGSTOREY('level-guid',$,'Ground floor',$,$,$,$,$,$);\n#5=IFCWALL('wall-guid',$,'External wall',$,$,$,$,$);\n#6=IFCSLAB('slab-guid',$,'Ground slab',$,$,$,$,$);\n#7=IFCBEAM('beam-guid',$,'Roof beam',$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;";
test('IFC inspector inventories schema, spatial structure, elements and SI units',()=>{
 const r=parseIfc(fixture);assert.equal(r.schema,'IFC4');assert.equal(r.records,7);assert.equal(r.lengthUnit,'m');assert.equal(r.buildingElementCount,3);assert.equal(r.spatialStructure.length,3);assert.equal(r.entityCounts.IFCWALL,1);assert.match(r.notice,/no geometric reconstruction/i);
});
test('IFC inspector handles quoted semicolons and nested argument lists',()=>{
 const r=parseIfc("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('id',$,'Wall; south',$,(1,2,3),$,$,$);\nENDSEC;\nEND-ISO-10303-21;");assert.equal(r.records,1);assert.equal(r.buildingElements[0].type,'IFCWALL');
});
test('IFC inspector identifies millimetre units',()=>{
 const r=parseIfc(fixture.replace('.LENGTHUNIT.,$,.METRE.','.LENGTHUNIT.,.MILLI.,.METRE.'));assert.equal(r.lengthUnit,'mm');
});
test('IFC inspector rejects malformed STEP envelope and unterminated arguments',()=>{
 assert.throws(()=>parseIfc('not IFC'),/Invalid IFC STEP envelope/);
 assert.throws(()=>parseIfc("ISO-10303-21;\nDATA;\n#1=IFCWALL('bad,$,$);\nENDSEC;\nEND-ISO-10303-21;"),/unterminated/);
});
