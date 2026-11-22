'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPdfDimensionLineEvidence}=require('../src/lib/mmc-ai/pdf-dimension-line-evidence');

const base={svgViewBox:[0,0,1000,500],pageWidthPt:1000,pageHeightPt:500};
test('finds a horizontal vector line aligned with a numeric dimension callout',()=>{
  const result=buildPdfDimensionLineEvidence({...base,
    textLines:[{page:1,text:'5500',box:{left:900,top:420,width:60,height:24}}],
    vectorPaths:[{id:'dim-line',points:[{x:400,y:205},{x:600,y:205}]}]
  });
  assert.equal(result.counts.dimensionCallouts,1);
  assert.equal(result.counts.calloutsWithLineCandidates,1);
  assert.equal(result.candidates[0].vectorLineCandidates[0].pathId,'dim-line');
  assert.equal(result.candidates[0].quantityEligible,false);
  assert.equal(result.candidates[0].dimensionValueApplied,false);
});
test('does not match a nearby diagonal vector as a dimension line',()=>{
  const result=buildPdfDimensionLineEvidence({...base,
    textLines:[{page:1,text:'5500 mm',box:{left:900,top:420,width:60,height:24}}],
    vectorPaths:[{id:'diagonal',points:[{x:400,y:205},{x:600,y:280}]}]
  });
  assert.equal(result.counts.calloutsWithLineCandidates,0);
});
test('does not turn reinforcement spacing text into a measured quantity',()=>{
  const result=buildPdfDimensionLineEvidence({...base,
    textLines:[{page:1,text:'Y16-200 C/C',box:{left:450,top:190,width:100,height:20}}],
    vectorPaths:[{id:'line',points:[{x:400,y:205},{x:600,y:205}]}]
  });
  assert.equal(result.counts.dimensionCallouts,0);
});
test('rejects incomplete coordinate inputs',()=>{
  assert.throws(()=>buildPdfDimensionLineEvidence({textLines:[],vectorPaths:[]}),/Valid text/);
});
