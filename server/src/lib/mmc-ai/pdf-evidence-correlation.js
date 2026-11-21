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
function correlatePdfTextWithVectorGeometry({ textLines = [], geometry, viewBox, pageWidthPt, pageHeightPt, maxDistancePx = 36 } = {}) {
  if (!Array.isArray(textLines) || !geometry || !Array.isArray(geometry.paths) || !Array.isArray(viewBox) || viewBox.length !== 4) {
    throw new TypeError('Text lines, vector geometry and SVG viewBox are required');
  }
  const [vx, vy, vw, vh] = viewBox;
  if (![vx, vy, vw, vh, pageWidthPt, pageHeightPt, maxDistancePx].every(Number.isFinite) || vw <= 0 || vh <= 0 || pageWidthPt <= 0 || pageHeightPt <= 0 || maxDistancePx <= 0) {
    throw new TypeError('Page dimensions, viewBox and matching distance must be positive finite values');
  }
  const svgAspect = vw / vh, pageAspect = pageWidthPt / pageHeightPt;
  const aspectDifference = Math.abs(svgAspect / pageAspect - 1);
  if (aspectDifference > 0.025) {
    return { status: 'coordinate_spaces_not_aligned', pageAspect: Number(pageAspect.toFixed(6)), svgAspect: Number(svgAspect.toFixed(6)), aspectDifference: Number(aspectDifference.toFixed(6)), associations: [], limitations: ['PDF text and SVG geometry aspect ratios differ by more than 2.5%; spatial associations were withheld.'] };
  }
  const targetWidth = 2000, targetHeight = targetWidth / pageAspect;
  const sx = targetWidth / vw, sy = targetHeight / vh;
  const pathBoxes = geometry.paths.map((path, index) => ({
    pathIndex: index + 1,
    box: bounds(path.points, p => ({ x: (p.x - vx) * sx, y: (p.y - vy) * sy }))
  })).filter(item => item.box);
  const candidates = textLines.slice(0, 1000).filter(line => line && line.box && typeof line.text === 'string' &&
    /\\d|\\b(?:B|BM|C|COL|F|FOOTING|S|SL|W|D|DB|AHU|FCU|VAV|P|MH|FH|SP)\\s*[-#]?\\s*\\d+|\\b(?:STRUCTURAL|FOUNDATION|REBAR|CONCRETE|BEAM|COLUMN|SLAB|FOOTING|Ø|T\\s*\\d)\\b|خرسانة|تسليح|عمود|جسر|قاعدة/i.test(line.text));
  const associations = candidates.map(line => {
    const textBox = { left: line.box.left, top: line.box.top, right: line.box.left + line.box.width, bottom: line.box.top + line.box.height };
    const nearest = pathBoxes.map(item => ({ pathIndex: item.pathIndex, distancePx: boxDistance(textBox, item.box) }))
      .filter(item => item.distancePx <= maxDistancePx)
      .sort((a, b) => a.distancePx - b.distancePx || a.pathIndex - b.pathIndex).slice(0, 3)
      .map(item => ({ pathIndex: item.pathIndex, distancePx: Number(item.distancePx.toFixed(2)) }));
    return { page: line.page || 1, text: line.text, textBox: line.box, nearbyVectorPaths: nearest,
      status: nearest.length ? 'nearby_vector_path_candidates_requires_visual_confirmation' : 'no_nearby_vector_path_found',
      measurementEligible: false };
  });
  return { status: 'spatial_candidates_generated_requires_visual_confirmation', coordinateSpace: 'normalized_page_width_2000px', pathCount: pathBoxes.length, textLineCount: candidates.length, matchedTextLineCount: associations.filter(x => x.nearbyVectorPaths.length).length, maxDistancePx, associations: associations.slice(0, 300), limitations: ['Nearest paths are spatial candidates only; they are not classified as engineering elements.','PDF text and SVG geometry are aligned by page aspect ratio, not by a verified drawing scale.','No dimensions, lengths, areas, volumes, BOQ quantities or 3D geometry are inferred.'] };
}

module.exports = { correlatePdfTextWithVectorGeometry, boxDistance };
