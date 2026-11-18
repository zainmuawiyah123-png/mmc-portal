'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { _test }=require('../src/routes/mmc-ai-boq');

test('BOQ discipline recognizes MDF and HDF joinery materials',()=>{
 assert.equal(_test.inferDiscipline('Supply and install MDF cabinet below TV'),'Joinery & Cabinetry');
 assert.equal(_test.inferDiscipline('Reception counter in HDF and MDF'),'Joinery & Cabinetry');
 assert.equal(_test.inferDiscipline('M.D.F shelves and storage'),'Joinery & Cabinetry');
});

test('BOQ discipline recognizes structural concrete abbreviations and slab',()=>{
 assert.equal(_test.inferDiscipline('PCC blinding concrete'),'Concrete & Structural');
 assert.equal(_test.inferDiscipline('RCC roof slab'),'Concrete & Structural');
 assert.equal(_test.inferDiscipline('Reinforced concrete slab'),'Concrete & Structural');
});

test('BOQ discipline keeps furniture and windows ahead of incidental materials',()=>{
 assert.equal(_test.inferDiscipline('Supply sofa with MDF side panels'),'Furniture & Fixtures');
 assert.equal(_test.inferDiscipline('Aluminium windows with glazing'),'Windows & Glazing');
});

test('Arabic and Western BOQ number formats remain parseable',()=>{
 assert.equal(_test.parseBoqNumber('١٬٢٥٠٫٥٠'),1250.5);
 assert.equal(_test.parseBoqNumber('1,250.50'),1250.5);
});
