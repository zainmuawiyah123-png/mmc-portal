'use strict';

/**
 * Conservative automatic 2D-footprint to 3D-prism reconstruction.
 * Inputs must be machine-extracted drawing evidence, never user-drawn geometry.
 * This module creates generic solids only; it does not guess whether a footprint
 * is a footing, slab, wall or excavation. Unknown/ambiguous candidates are held.
 */
const round = n => Number(n.toFixed(6));
const finitePositive = (n, name) => {
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(name + ' must be a finite positive number');
};
function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}
function normalizeRectangle(points, tolerance = 1e-6) {
  if (!Array.isArray(points) || points.length < 4) return null;
  const p = points.map(x => ({ x: Number(x.x), y: Number(x.y) }));
  if (p.some(x => !Number.isFinite(x.x) || !Number.isFinite(x.y))) return null;
  if (p.length > 4 && Math.hypot(p[0].x-p.at(-1).x,p[0].y-p.at(-1).y) <= tolerance) p.pop();
  if (p.length !== 4) return null;
  const edges = p.map((a,i) => {
    const b=p[(i+1)%4];
    return {x:b.x-a.x,y:b.y-a.y,length:Math.hypot(b.x-a.x,b.y-a.y)};
  });
  if (edges.some(e=>e.length<=tolerance)) return null;
  for(let i=0;i<4;i++){
    const a=edges[i],b=edges[(i+1)%4];
    if(Math.abs(a.x*b.x+a.y*b.y)>tolerance*a.length*b.length) return null;
  }
  const area=polygonArea(p);
  if(area<=tolerance) return null;
  const xs=p.map(x=>x.x),ys=p.map(x=>x.y);
  const width=Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y);
  const length=Math.hypot(p[2].x-p[1].x,p[2].y-p[1].y);
  return {points:p,area,width,length,centroid:{x:round(p.reduce((s,x)=>s+x.x,0)/4),y:round(p.reduce((s,x)=>s+x.y,0)/4)}};
}
function reconstructPrismaticModel({ candidates, mmPerDrawingUnit, minimumConfidence = 0.9 } = {}) {
  finitePositive(mmPerDrawingUnit,'mmPerDrawingUnit');
  if(!Array.isArray(candidates)) throw new TypeError('machine-detected candidates array is required');
  if(!Number.isFinite(minimumConfidence)||minimumConfidence<0||minimumConfidence>1) throw new TypeError('minimumConfidence must be between 0 and 1');
  const solids=[],unresolved=[];
  for(const candidate of candidates){
    const id=String(candidate?.id||'').trim();
    const footprint=normalizeRectangle(candidate?.footprint?.points);
    const height=candidate?.heightEvidence;
    const evidenceOk=height&&Number.isFinite(height.heightMm)&&height.heightMm>0&&
      typeof height.sourceText==='string'&&height.sourceText.trim()&&
      Number.isFinite(height.confidence)&&height.confidence>=minimumConfidence&&
      height.pageNumber>=1&&Number.isInteger(height.pageNumber);
    if(!id||!candidate?.footprint?.closed||!footprint||!evidenceOk){
      unresolved.push({candidateId:id||null,reason:!footprint?'footprint_not_supported_as_rectangle':!evidenceOk?'verified_height_evidence_missing_or_low_confidence':'closed_footprint_required'});
      continue;
    }
    const scale=mmPerDrawingUnit/1000;
    const widthM=footprint.width*scale,lengthM=footprint.length*scale,heightM=height.heightMm/1000;
    const areaM2=footprint.area*scale*scale,volumeM3=areaM2*heightM;
    const z0=Number.isFinite(candidate.baseElevationMm)?candidate.baseElevationMm/1000:0,z1=z0+heightM;
    const vertices=footprint.points.map(p=>({x:round(p.x*scale),y:round(p.y*scale),z:round(z0)}))
      .concat(footprint.points.map(p=>({x:round(p.x*scale),y:round(p.y*scale),z:round(z1)})));
    const faces=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
    solids.push({
      id,kind:'unclassified_rectangular_prism',source:{pageNumber:candidate.footprint.pageNumber??null,pathIndex:candidate.footprint.pathIndex??null},
      dimensions:{lengthM:round(Math.max(lengthM,widthM)),widthM:round(Math.min(lengthM,widthM)),heightM:round(heightM)},
      footprintAreaM2:round(areaM2),volumeM3:round(volumeM3),baseElevationM:round(z0),
      vertices,faces,
      heightEvidence:{sourceText:height.sourceText,pageNumber:height.pageNumber,confidence:height.confidence},
      classification:'unresolved_generic_solid',reviewState:'requires_automatic_cross_sheet_classification',approvalEligible:false
    });
  }
  return {
    engine:'mmc-2d-to-3d-prismatic-reconstruction-v1',
    status:unresolved.length?'partial_3d_model_requires_more_drawing_evidence':'3d_geometry_reconstructed_requires_classification',
    coordinateUnits:'m',scale:{mmPerDrawingUnit,source:'verified_page_calibration_required'},
    solidCount:solids.length,unresolvedCount:unresolved.length,
    totalPrismaticVolumeM3:round(solids.reduce((s,x)=>s+x.volumeM3,0)),
    totalFootprintAreaM2:round(solids.reduce((s,x)=>s+x.footprintAreaM2,0)),
    solids,unresolved,
    limitations:[
      'Only closed rectangular footprints and machine-extracted height annotations above the confidence threshold are reconstructed.',
      'No element type, material, reinforcement, excavation scope or BOQ code is guessed.',
      'This is a geometric 3D mesh representation; classification requires cross-sheet engineering evidence.',
      'Missing heights or unsupported shapes remain unresolved rather than being modelled by hand or estimated.'
    ],
    approvalEligible:false
  };
}
module.exports={polygonArea,normalizeRectangle,reconstructPrismaticModel};
