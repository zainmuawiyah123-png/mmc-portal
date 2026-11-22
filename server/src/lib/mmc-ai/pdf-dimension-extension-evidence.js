'use strict';

// Looks for two perpendicular extension-line candidates attached near the
// endpoints of an already-detected dimension-line candidate. Evidence only.
function distancePointToSegment(p,a,b){
 const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
 if(!l2)return Math.hypot(p.x-a.x,p.y-a.y);
 const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2));
 return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
function buildPdfDimensionExtensionEvidence({dimensionLineEvidence,vectorPaths=[],svgViewBox,pageWidthPt,pageHeightPt,endpointTolerancePx=32,minExtensionPx=8,maxExtensionPx=260}={}){
 if(!dimensionLineEvidence||!Array.isArray(dimensionLineEvidence.candidates)||!Array.isArray(vectorPaths)||
 !Array.isArray(svgViewBox)||svgViewBox.length!==4||
 ![...svgViewBox,pageWidthPt,pageHeightPt,endpointTolerancePx,minExtensionPx,maxExtensionPx].every(Number.isFinite)||
 svgViewBox[2]<=0||svgViewBox[3]<=0||pageWidthPt<=0||pageHeightPt<=0)throw new TypeError('Dimension-line evidence, vector paths and valid page coordinates are required');
 const [vx,vy,vw,vh]=svgViewBox,targetWidth=2000,targetHeight=2000*pageHeightPt/pageWidthPt,sx=targetWidth/vw,sy=targetHeight/vh;
 const segments=[];
 vectorPaths.forEach((path,pathIndex)=>{
  if(!Array.isArray(path.points)||path.points.length<2)return;
  for(let i=1;i<path.points.length;i++){
   const p=path.points[i-1],q=path.points[i];
   const a={x:(p.x-vx)*sx,y:(p.y-vy)*sy},b={x:(q.x-vx)*sx,y:(q.y-vy)*sy};
   const dx=Math.abs(b.x-a.x),dy=Math.abs(b.y-a.y),length=Math.hypot(dx,dy);
   const orientation=dy<=Math.max(1.25,length*.012)?'horizontal':dx<=Math.max(1.25,length*.012)?'vertical':null;
   if(orientation&&length>=minExtensionPx&&length<=maxExtensionPx)segments.push({pathId:path.id||'vector-'+(pathIndex+1),segmentIndex:i,orientation,a,b,length});
  }
 });
 const results=dimensionLineEvidence.candidates.map(callout=>{
  const found=[];
  for(const line of callout.vectorLineCandidates||[]){
   const source=vectorPaths.find((p,index)=>(p.id||'vector-'+(index+1))===line.pathId);
   if(!source||!Array.isArray(source.points)||!source.points[line.segmentIndex-1]||!source.points[line.segmentIndex])continue;
   const p=source.points[line.segmentIndex-1],q=source.points[line.segmentIndex];
   const a={x:(p.x-vx)*sx,y:(p.y-vy)*sy},b={x:(q.x-vx)*sx,y:(q.y-vy)*sy};
   const expected=line.orientation==='horizontal'?'vertical':'horizontal';
   const nearA=segments.filter(s=>s.orientation===expected&&!(s.pathId===line.pathId&&s.segmentIndex===line.segmentIndex)&&distancePointToSegment(a,s.a,s.b)<=endpointTolerancePx);
   const nearB=segments.filter(s=>s.orientation===expected&&!(s.pathId===line.pathId&&s.segmentIndex===line.segmentIndex)&&distancePointToSegment(b,s.a,s.b)<=endpointTolerancePx);
   const pairs=[];
   for(const left of nearA)for(const right of nearB){
    if(left.pathId===right.pathId&&left.segmentIndex===right.segmentIndex)continue;
    pairs.push({endpointA:{pathId:left.pathId,segmentIndex:left.segmentIndex},endpointB:{pathId:right.pathId,segmentIndex:right.segmentIndex}});
   }
   found.push({dimensionLine:{pathId:line.pathId,segmentIndex:line.segmentIndex},orientation:line.orientation,
    extensionLinePairCandidates:pairs.slice(0,3),pairCount:pairs.length,
    status:pairs.length?'two_endpoint_extension_candidates_found':'complete_extension_pair_not_found'});
  }
  return {page:callout.page,rawCallout:callout.rawCallout,dimensionLineChecks:found,
   hasTwoExtensionLineCandidates:found.some(x=>x.pairCount>0),dimensionValueApplied:false,measurementEligible:false,quantityEligible:false};
 });
 return {engine:'mmc-pdf-dimension-extension-evidence-v0.1',status:results.length?'extension_line_pairing_examined':'no_dimension_callouts_to_check',
  counts:{calloutsExamined:results.length,calloutsWithTwoExtensionCandidates:results.filter(x=>x.hasTwoExtensionLineCandidates).length},
  candidates:results,notice:'Perpendicular segments near both dimension-line endpoints are only extension-line candidates. Arrowheads/ticks, dimension text semantics, element boundary association and scale remain unverified; no measurements or BOQ quantities are produced.'};
}
module.exports={buildPdfDimensionExtensionEvidence};
