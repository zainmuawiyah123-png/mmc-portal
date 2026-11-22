'use strict';

// Detects straight vector segments that may be dimension lines near explicit
// numeric callouts. This is evidence only: no dimension value is applied.
const DIMENSION_TEXT = /(?:\\b\\d+(?:[.,]\\d+)?\\s*(?:mm|cm|m)\\b|\\b\\d{2,6}(?:[.,]\\d+)?\\b|[ØΦøφ]\\s*\\d+)/i;

function pointSegmentDistance(point, a, b) {
  const dx=b.x-a.x, dy=b.y-a.y, length2=dx*dx+dy*dy;
  if (!length2) return Math.hypot(point.x-a.x,point.y-a.y);
  const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length2));
  return Math.hypot(point.x-(a.x+t*dx),point.y-(a.y+t*dy));
}
function segmentBoxDistance(a,b,box) {
  const right=box.left+box.width, bottom=box.top+box.height;
  const corners=[{x:box.left,y:box.top},{x:right,y:box.top},{x:right,y:bottom},{x:box.left,y:bottom}];
  const inside=p=>p.x>=box.left&&p.x<=right&&p.y>=box.top&&p.y<=bottom;
  if(inside(a)||inside(b)) return 0;
  const orient=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
  const intersects=(p1,p2,q1,q2)=>{
    const a1=orient(p1,p2,q1),a2=orient(p1,p2,q2),b1=orient(q1,q2,p1),b2=orient(q1,q2,p2);
    return a1*a2<=0&&b1*b2<=0;
  };
  for(let i=0;i<4;i++) if(intersects(a,b,corners[i],corners[(i+1)%4])) return 0;
  return Math.min(...corners.map(p=>pointSegmentDistance(p,a,b)),
    ...[a,b].map(p=>Math.hypot(Math.max(0,box.left-p.x,p.x-right),Math.max(0,box.top-p.y,p.y-bottom))));
}
function buildPdfDimensionLineEvidence({textLines=[],vectorPaths=[],svgViewBox=null,pageWidthPt=null,pageHeightPt=null,maxDistancePx=110}={}) {
  if(!Array.isArray(textLines)||!Array.isArray(vectorPaths)||!Array.isArray(svgViewBox)||svgViewBox.length!==4||
    ![...svgViewBox,pageWidthPt,pageHeightPt,maxDistancePx].every(Number.isFinite)||svgViewBox[2]<=0||svgViewBox[3]<=0||pageWidthPt<=0||pageHeightPt<=0) {
    throw new TypeError('Valid text, vector paths, SVG viewBox and page dimensions are required');
  }
  const [vx,vy,vw,vh]=svgViewBox;
  const targetWidth=2000,targetHeight=targetWidth/(pageWidthPt/pageHeightPt);
  const sx=targetWidth/vw,sy=targetHeight/vh;
  const segments=[];
  vectorPaths.forEach((path,pathIndex)=>{
    if(!Array.isArray(path.points)||path.points.length<2)return;
    for(let i=1;i<path.points.length;i++){
      const p=path.points[i-1],q=path.points[i];
      const a={x:(p.x-vx)*sx,y:(p.y-vy)*sy},b={x:(q.x-vx)*sx,y:(q.y-vy)*sy};
      const dx=Math.abs(b.x-a.x),dy=Math.abs(b.y-a.y),length=Math.hypot(dx,dy);
      if(length<18||length>1800)continue;
      const orientation=dy<=Math.max(1.25,length*0.012)?'horizontal':dx<=Math.max(1.25,length*0.012)?'vertical':null;
      if(!orientation)continue;
      segments.push({pathIndex:path.id||'vector-'+(pathIndex+1),segmentIndex:i,orientation,a,b,length});
    }
  });
  const candidates=[];
  for(const line of textLines){
    if(!line||typeof line.text!=='string'||!line.box||![line.box.left,line.box.top,line.box.width,line.box.height].every(Number.isFinite)||!DIMENSION_TEXT.test(line.text))continue;
    const box=line.box,center={x:box.left+box.width/2,y:box.top+box.height/2};
    const matches=segments.map(segment=>{
      const distancePx=segmentBoxDistance(segment.a,segment.b,box);
      const along=segment.orientation==='horizontal'
        ? center.x>=Math.min(segment.a.x,segment.b.x)-box.width&&center.x<=Math.max(segment.a.x,segment.b.x)+box.width
        : center.y>=Math.min(segment.a.y,segment.b.y)-box.height&&center.y<=Math.max(segment.a.y,segment.b.y)+box.height;
      return {...segment,distancePx,alignedWithCallout:along};
    }).filter(item=>item.alignedWithCallout&&item.distancePx<=maxDistancePx)
      .sort((a,b)=>a.distancePx-b.distancePx||b.length-a.length).slice(0,5)
      .map(item=>({pathId:item.pathIndex,segmentIndex:item.segmentIndex,orientation:item.orientation,
        lengthPx:Number(item.length.toFixed(2)),distancePx:Number(item.distancePx.toFixed(2)),
        alignedWithCallout:true,status:'dimension_line_candidate_requires_extension_line_and_element_validation'}));
    candidates.push({page:line.page||1,rawCallout:line.text,calloutBox:box,vectorLineCandidates:matches,
      status:matches.length?'nearby_dimension_line_candidates_found':'no_dimension_line_candidate_found',
      dimensionValueApplied:false,measurementEligible:false,quantityEligible:false});
  }
  return {engine:'mmc-pdf-dimension-line-evidence-v0.1',status:candidates.length?'dimension_callouts_examined':'no_dimension_callouts_found',
    counts:{dimensionCallouts:candidates.length,calloutsWithLineCandidates:candidates.filter(x=>x.vectorLineCandidates.length).length,
      straightVectorSegments:segments.length},candidates,
    notice:'Straight-line proximity and alignment only. Extension-line pairing, arrows/ticks, element association, scale and dimension value remain unverified; no measurements or BOQ quantities are produced.'};
}
module.exports={buildPdfDimensionLineEvidence};
