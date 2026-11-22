'use strict';

function bounds(points, transform) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const mapped = points.map(transform);
  if (mapped.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const xs = mapped.map(p => p.x), ys = mapped.map(p => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
function boxDistance(a, b) {
  const dx = Math.max(0, a.left - b.right, b.left - a.right);
  const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(dx, dy);
}
function correlatePdfTextWithVectorGeometry({ textLines = [], geometry, viewBox, pageWidthPt, pageHeightPt, pageRotationDegrees = 0, maxDistancePx = 36 } = {}) {
  if (!Array.isArray(textLines) || !geometry || !Array.isArray(geometry.paths) || !Array.isArray(viewBox) || viewBox.length !== 4) {
    throw new TypeError('Text lines, vector geometry and SVG viewBox are required');
  }
  const [vx, vy, vw, vh] = viewBox;
  if (![vx, vy, vw, vh, pageWidthPt, pageHeightPt, pageRotationDegrees, maxDistancePx].every(Number.isFinite) || vw <= 0 || vh <= 0 || pageWidthPt <= 0 || pageHeightPt <= 0 || maxDistancePx <= 0 || ![0,90,180,270].includes(((pageRotationDegrees%360)+360)%360)) {
    throw new TypeError('Page dimensions, rotation, viewBox and matching distance must be valid');
  }
  const rotation=((pageRotationDegrees%360)+360)%360;
  const svgAspect=vw/vh, rawPageAspect=pageWidthPt/pageHeightPt;
  const rotated=rotation===90||rotation===270;
  const pageAspect=rotated?1/rawPageAspect:rawPageAspect;
  const aspectDifference=Math.abs(svgAspect/pageAspect-1);
  if(aspectDifference>0.025){
    return {status:'coordinate_spaces_not_aligned',pageAspect:Number(pageAspect.toFixed(6)),rawPageAspect:Number(rawPageAspect.toFixed(6)),svgAspect:Number(svgAspect.toFixed(6)),pageRotationDegrees:rotation,aspectDifference:Number(aspectDifference.toFixed(6)),associations:[],limitations:['PDF page orientation and SVG geometry aspect ratios differ by more than 2.5%; spatial associations were withheld.']};
  }
  const targetWidth=2000,targetHeight=targetWidth/pageAspect;
  const sx=targetWidth/vw,sy=targetHeight/vh;
  const pathBoxes = geometry.paths.map((path, index) => ({
    pathIndex: index + 1,
    box: bounds(path.points, p => ({ x: (p.x - vx) * sx, y: (p.y - vy) * sy }))
  })).filter(item => item.box);
  const candidates = textLines.slice(0, 1000).filter(line => line && line.box && typeof line.text === 'string' &&
    /\d|\b(?:B|BM|C|COL|F|FOOTING|S|SL|W|D|DB|AHU|FCU|VAV|P|MH|FH|SP)\s*[-#]?\s*\d+|\b(?:STRUCTURAL|FOUNDATION|REBAR|CONCRETE|BEAM|COLUMN|SLAB|FOOTING|Ø|T\s*\d)\b|خرسانة|تسليح|عمود|جسر|قاعدة/i.test(line.text));
  const associations = candidates.map(line => {
    let normalizedBox={...line.box};
    if(rotation===90) normalizedBox={left:targetHeight-(line.box.top+line.box.height),top:line.box.left,width:line.box.height,height:line.box.width};
    else if(rotation===270) normalizedBox={left:line.box.top,top:targetWidth-(line.box.left+line.box.width),width:line.box.height,height:line.box.width};
    else if(rotation===180) normalizedBox={left:targetWidth-(line.box.left+line.box.width),top:targetHeight-(line.box.top+line.box.height),width:line.box.width,height:line.box.height};
    const textBox = { left: normalizedBox.left, top: normalizedBox.top, right: normalizedBox.left + normalizedBox.width, bottom: normalizedBox.top + normalizedBox.height };
    const nearest = pathBoxes.map(item => ({ pathIndex: item.pathIndex, distancePx: boxDistance(textBox, item.box) }))
      .filter(item => item.distancePx <= maxDistancePx)
      .sort((a, b) => a.distancePx - b.distancePx || a.pathIndex - b.pathIndex).slice(0, 3)
      .map(item => ({ pathIndex: item.pathIndex, distancePx: Number(item.distancePx.toFixed(2)) }));
    return { page: line.page || 1, text: line.text, textBox: line.box, nearbyVectorPaths: nearest,
      status: nearest.length ? 'nearby_vector_path_candidates_requires_visual_confirmation' : 'no_nearby_vector_path_found',
      measurementEligible: false };
  });
  return { status: 'spatial_candidates_generated_requires_visual_confirmation', coordinateSpace: 'normalized_page_width_2000px', pageRotationDegrees: rotation, rotationApplied: rotation !== 0, pathCount: pathBoxes.length, textLineCount: candidates.length, matchedTextLineCount: associations.filter(x => x.nearbyVectorPaths.length).length, maxDistancePx, associations: associations.slice(0, 300), limitations: ['Nearest paths are spatial candidates only; they are not classified as engineering elements.','PDF text and SVG geometry are aligned by page aspect ratio, not by a verified drawing scale.','No dimensions, lengths, areas, volumes, BOQ quantities or 3D geometry are inferred.'] };
}


function spatialOcrLines(words, { pageWidthPt, pageHeightPt, maxRenderSide = 2600 } = {}) {
  if (!Array.isArray(words) || !(pageWidthPt > 0) || !(pageHeightPt > 0)) return [];
  const renderScale = maxRenderSide / Math.max(pageWidthPt, pageHeightPt);
  const renderedWidth = pageWidthPt * renderScale;
  const normalizedScale = 2000 / renderedWidth;
  const groups = new Map();
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !word.text.trim() || !word.box) continue;
    const { left, top, width, height } = word.box;
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const key = [word.page || 1, word.block || 0, word.paragraph || 0, word.line || 0].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...word, box: { left: left * normalizedScale, top: top * normalizedScale, width: width * normalizedScale, height: height * normalizedScale } });
  }
  return [...groups.values()].map(group => {
    group.sort((a,b) => a.box.left - b.box.left);
    const left = Math.min(...group.map(w => w.box.left)), top = Math.min(...group.map(w => w.box.top));
    const right = Math.max(...group.map(w => w.box.left + w.box.width)), bottom = Math.max(...group.map(w => w.box.top + w.box.height));
    return { page: group[0].page || 1, text: group.map(w => w.text.trim()).join(' '),
      box: { left, top, width: right-left, height: bottom-top }, source: 'tesseract_tsv_normalized_page' };
  }).sort((a,b) => a.box.top-b.box.top || a.box.left-b.box.left).slice(0,5000);
}

module.exports = { correlatePdfTextWithVectorGeometry, boxDistance, spatialOcrLines };
