'use strict';

/**
 * MMC AI — evidence graph for automatic drawing interpretation.
 *
 * This is the bridge between PDF/OCR/DXF extraction and BOQ calculation.
 * It does NOT turn nearby text or arbitrary vectors into quantities.
 * Every relation is retained with source evidence and an explicit status.
 */
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const center = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function validBox(box) {
  return box && [box.left, box.top, box.width, box.height].every(Number.isFinite) &&
    box.width > 0 && box.height > 0;
}
function boxCenter(box) { return center(box); }
function normalizeTag(value) {
  const m = clean(value).match(/\b(?:B|BM|C|COL|F|FOOTING|S|SL|W|D|DB|MH|P)-?\s*\d{1,4}[A-Z]?\b/i);
  return m ? m[0].replace(/[\s-]+/g, '').toUpperCase() : null;
}
function classifyAnnotation(text) {
  const s = clean(text);
  const types = [];
  if (/\b(?:Y|T|Ø|Φ)\s*\d{1,2}(?:\s*[-@/]\s*\d{2,4})?/i.test(s)) types.push('reinforcement_callout');
  if (/\b(?:B|BM|C|COL|F|FOOTING|S|SL|W|MH|P)-?\s*\d{1,4}[A-Z]?\b/i.test(s)) types.push('element_tag');
  if (/\b\d+(?:\.\d+)?\s*(?:mm|cm|m)\b|\b\d+\s*[x×]\s*\d+\b/i.test(s)) types.push('dimension_text');
  if (/\b(?:CONCRETE|REINFORCEMENT|BEAM|COLUMN|SLAB|FOOTING|WALL|FOUNDATION|PIPE|MANHOLE)\b|خرسانة|تسليح|جدار|بلاطة|قاعدة|أنبوب/i.test(s)) types.push('discipline_or_element_text');
  return [...new Set(types)];
}
function normalizeEvidenceLine(line, index) {
  if (!line || typeof line.text !== 'string' || !validBox(line.box)) return null;
  return {
    id: line.id || 'txt-' + (index + 1),
    page: Number.isInteger(line.page) && line.page > 0 ? line.page : 1,
    text: clean(line.text),
    box: { left: line.box.left, top: line.box.top, width: line.box.width, height: line.box.height },
    confidence: Number.isFinite(line.confidence) ? line.confidence : null,
    source: line.source || 'pdf_or_ocr_text'
  };
}
function normalizePath(path, index) {
  if (!path || !Array.isArray(path.points) || path.points.length < 2) return null;
  const points = path.points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length < 2) return null;
  return {
    id: path.id || 'vec-' + (index + 1),
    page: Number.isInteger(path.page) && path.page > 0 ? path.page : 1,
    points,
    closed: path.closed === true,
    lengthUnits: Number.isFinite(path.lengthUnits) ? path.lengthUnits : null,
    areaSquareUnits: Number.isFinite(path.areaSquareUnits) ? path.areaSquareUnits : null,
    layer: clean(path.layer || ''),
    source: path.source || 'pdf_vector_geometry'
  };
}
function pathCenter(path) {
  const xs = path.points.map(p => p.x), ys = path.points.map(p => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}
function buildDrawingIntelligenceModel(input = {}, options = {}) {
  const maxRelationDistance = Number.isFinite(options.maxRelationDistance) ? options.maxRelationDistance : 90;
  if (!(maxRelationDistance > 0)) throw new TypeError('maxRelationDistance must be positive.');
  const lines = (Array.isArray(input.textLines) ? input.textLines : [])
    .map(normalizeEvidenceLine).filter(Boolean);
  const paths = (Array.isArray(input.vectorPaths) ? input.vectorPaths : [])
    .map(normalizePath).filter(Boolean);
  const annotations = lines.map(line => ({
    ...line,
    candidateTypes: classifyAnnotation(line.text),
    elementTag: normalizeTag(line.text)
  })).filter(item => item.candidateTypes.length);

  const elements = annotations.filter(a => a.candidateTypes.includes('element_tag')).map(tag => {
    const tagPoint = boxCenter(tag.box);
    const nearbyDimensions = annotations.filter(a => a.page === tag.page &&
      a.id !== tag.id && a.candidateTypes.includes('dimension_text'))
      .map(a => ({ evidenceId: a.id, text: a.text, distance: distance(tagPoint, boxCenter(a.box)) }))
      .filter(x => x.distance <= maxRelationDistance)
      .sort((a,b) => a.distance-b.distance).slice(0, 8);
    const nearbyReinforcement = annotations.filter(a => a.page === tag.page &&
      a.candidateTypes.includes('reinforcement_callout'))
      .map(a => ({ evidenceId: a.id, text: a.text, distance: distance(tagPoint, boxCenter(a.box)) }))
      .filter(x => x.distance <= maxRelationDistance)
      .sort((a,b) => a.distance-b.distance).slice(0, 8);
    const nearbyGeometry = paths.filter(p => p.page === tag.page)
      .map(p => ({ pathId: p.id, distance: distance(tagPoint, pathCenter(p)), closed: p.closed,
        lengthUnits: p.lengthUnits, areaSquareUnits: p.areaSquareUnits, layer: p.layer }))
      .filter(x => x.distance <= maxRelationDistance)
      .sort((a,b) => a.distance-b.distance).slice(0, 12);
    return {
      id: 'element-' + tag.id,
      tag: tag.elementTag,
      page: tag.page,
      sourceEvidence: [tag.id],
      dimensionCandidates: nearbyDimensions,
      reinforcementCandidates: nearbyReinforcement,
      geometryCandidates: nearbyGeometry,
      status: nearbyGeometry.length ? 'spatially_correlated_unclassified' : 'tag_detected_geometry_not_linked',
      quantityEligible: false
    };
  });

  const unresolved = [];
  for (const element of elements) {
    if (!element.geometryCandidates.length) unresolved.push({ elementId: element.id, missing: ['verified_element_geometry'] });
    if (!element.dimensionCandidates.length) unresolved.push({ elementId: element.id, missing: ['dimension_to_element_relation'] });
    if (!element.reinforcementCandidates.length) unresolved.push({ elementId: element.id, missing: ['reinforcement_detail_or_not_applicable_confirmation'] });
  }
  const counts = {
    textLines: lines.length,
    vectorPaths: paths.length,
    annotations: annotations.length,
    elementCandidates: elements.length,
    spatiallyCorrelatedElements: elements.filter(e => e.geometryCandidates.length).length,
    quantityEligibleElements: 0
  };
  return {
    engine: 'mmc-drawing-intelligence-graph-v0.1',
    status: elements.length ? 'evidence_graph_created_requires_semantic_validation' : 'evidence_extracted_no_element_tags',
    coordinateSpace: 'input_page_coordinates; all relations are page-local',
    counts,
    annotations,
    elements,
    unresolved,
    boq: {
      status: 'withheld_no_verified_element_geometry',
      rows: [],
      reason: 'No BOQ quantity is emitted from spatial proximity alone. Element identity, geometry, scale, dimensions and exclusions must be validated first.'
    },
    limitations: [
      'Nearest annotations and vector paths are candidates, not proven engineering relationships.',
      'A closed vector path may be a border, hatch boundary, dimension frame or structural element.',
      'Scale calibration and dimension-line endpoint association are not performed by this module.',
      'Reinforcement callouts do not establish bar lengths, counts, bends, laps or mass.',
      'No concrete, earthwork, architectural or MEP quantity is inferred.'
    ]
  };
}
module.exports = { buildDrawingIntelligenceModel, classifyAnnotation, normalizeTag };
