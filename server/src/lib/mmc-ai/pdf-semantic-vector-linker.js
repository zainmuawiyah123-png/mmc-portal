'use strict';

// Page-local PDF vector/text linking. This creates auditable candidates only;
// proximity is never promoted to a measured BOQ quantity.
const clean = value => String(value || '').normalize('NFKC').replace(/\\s+/g, ' ').trim();
const center = b => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
function semantic(text) {
  const s = clean(text).toUpperCase();
  const rules = [
    ['reinforced_concrete_wall', /\\b(?:R\\.?C\\.?\\s*)?(?:WALL|WALLS|RETAINING WALL)\\b|جدار خرسانة/],
    ['reinforced_concrete_slab', /\\b(?:R\\.?C\\.?\\s*)?(?:SLAB|SLABS|ROOF SLAB)\\b|بلاطة خرسانة/],
    ['isolated_footing', /\\b(?:ISOLATED )?FOOTING(?:S)?\\b|قواعد منفصلة/],
    ['column', /\\b(?:COLUMN|COL\\.?|PILLAR)S?\\b|عمود/],
    ['beam', /\\b(?:BEAM|GIRDER)S?\\b|جسر/],
    ['pipe', /\\b(?:UPVC|PVC|PIPE|DRAIN|SEWER)\\b|أنبوب|ماسورة/],
    ['manhole', /\\bMANHOLE\\b|غرفة تفتيش/]
  ];
  return rules.filter(([,re]) => re.test(s)).map(([type])=>type);
}
function bbox(points) {
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  const left=Math.min(...xs), top=Math.min(...ys), right=Math.max(...xs), bottom=Math.max(...ys);
  return {left,top,width:right-left,height:bottom-top};
}
function inside(p,b,pad=0) {
  return p.x>=b.left-pad && p.x<=b.left+b.width+pad && p.y>=b.top-pad && p.y<=b.top+b.height+pad;
}
function buildPdfElementCandidates({ textLines=[], vectorPaths=[], svgViewBox=null, pageSizePt=null, maxDistance=48 }={}) {
  if (!Array.isArray(textLines)||!Array.isArray(vectorPaths)) throw new TypeError('textLines and vectorPaths must be arrays');
  const view = Array.isArray(svgViewBox)&&svgViewBox.length===4 ? svgViewBox : null;
  const page = pageSizePt && Number.isFinite(pageSizePt.widthPt)&&Number.isFinite(pageSizePt.heightPt) ? pageSizePt : null;
  const normalizedTexts = textLines.filter(t=>t&&typeof t.text==='string'&&t.box&&
    ['left','top','width','height'].every(k=>Number.isFinite(t.box[k]))&&t.box.width>0&&t.box.height>0)
    .map(t=>{
      let box={...t.box};
      // pdftotext normalized boxes are page fractions; map into SVG viewBox.
      if (t.box.coordinateSpace==='display_page_fraction_unclamped' && view) {
        box={left:view[0]+t.box.left*view[2],top:view[1]+t.box.top*view[3],
          width:t.box.width*view[2],height:t.box.height*view[3]};
      } else if (page && view && t.box.coordinateSpace==='pdftotext-bbox-page-space') {
        box={left:view[0]+t.box.left/page.widthPt*view[2],top:view[1]+t.box.top/page.heightPt*view[3],
          width:t.box.width/page.widthPt*view[2],height:t.box.height/page.heightPt*view[3]};
      }
      return {...t,box,types:semantic(t.text)};
    }).filter(t=>t.types.length);
  const paths=vectorPaths.filter(p=>Array.isArray(p.points)&&p.points.length>=2)
    .map((p,i)=>({...p,id:p.id||'pdf-vector-'+(i+1),bounds:bbox(p.points)}));
  const candidates=[];
  for(const label of normalizedTexts){
    const c=center(label.box);
    const matches=paths.map(p=>{
      const pc=center(p.bounds), d=distance(c,pc);
      const contains=inside(c,p.bounds,2);
      const overlap=inside(pc,label.box,0);
      return {pathId:p.id,distance:d,containsLabel:contains,labelOverlapsPathCenter:overlap,
        closed:p.closed===true,lengthUnits:p.lengthUnits??null,areaSquareUnits:p.areaSquareUnits??null,
        bounds:p.bounds};
    }).filter(x=>x.containsLabel||x.labelOverlapsPathCenter||x.distance<=maxDistance)
      .sort((a,b)=>(Number(b.containsLabel)-Number(a.containsLabel))||a.distance-b.distance).slice(0,5);
    candidates.push({id:'candidate-'+label.id, page:label.page||1, label:clean(label.text),
      semanticTypes:label.types, sourceTextId:label.id||null, geometryCandidates:matches,
      status:matches.length?'semantic_label_linked_to_candidate_geometry':'semantic_label_without_nearby_geometry',
      quantityEligible:false, evidenceOnly:true});
  }
  return {engine:'mmc-pdf-semantic-vector-linker-v0.1',status:candidates.length?'candidate_links_created':'no_semantic_labels_found',
    counts:{semanticLabels:normalizedTexts.length,vectorPaths:paths.length,linkedLabels:candidates.filter(c=>c.geometryCandidates.length).length},
    candidates,notice:'Semantic label and nearby vector association only. It does not prove element topology, scale, dimensions, openings or BOQ quantities.'};
}
module.exports={buildPdfElementCandidates,semantic};
