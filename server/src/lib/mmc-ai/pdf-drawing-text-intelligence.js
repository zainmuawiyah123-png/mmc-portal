'use strict';

/**
 * Conservative PDF drawing-sheet text intelligence.
 * Extracts explicit title-block and cross-reference clues from the existing
 * PDF text extractor and optional OCR text. It does not perform page-layout analysis, scale
 * calibration, geometry reconstruction or quantity takeoff.
 */
function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function unique(items) {
  return [...new Set(items.map(clean).filter(Boolean))];
}
function collect(text, regex, map = match => match[1]) {
  const out = [];
  let match;
  while ((match = regex.exec(text))) out.push(map(match));
  return unique(out);
}
function spatialOcrLines(words) {
  if (!Array.isArray(words)) return [];
  const groups = new Map();
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !word.box || !Number.isFinite(word.page)) continue;
    const key = [word.page, word.block ?? 0, word.paragraph ?? 0, word.line ?? 0].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  return [...groups.values()].map(group => {
    const sorted = group.slice().sort((a, b) => a.box.left - b.box.left);
    const left = Math.min(...sorted.map(word => word.box.left));
    const top = Math.min(...sorted.map(word => word.box.top));
    const right = Math.max(...sorted.map(word => word.box.left + word.box.width));
    const bottom = Math.max(...sorted.map(word => word.box.top + word.box.height));
    let cursor = 0;
    const wordBoxes = sorted.map(word => {
      const start = cursor;
      cursor += word.text.length;
      const end = cursor;
      cursor += 1;
      return {
        text: word.text,
        start,
        end,
        confidence: Number.isFinite(word.confidence) ? word.confidence : null,
        box: { ...word.box }
      };
    });
    return {
      page: sorted[0].page,
      text: sorted.map(word => word.text).join(' '),
      confidence: Number((sorted.reduce((sum, word) => sum + (Number.isFinite(word.confidence) ? word.confidence : 0), 0) / sorted.length).toFixed(2)),
      box: { left, top, width: right - left, height: bottom - top },
      coordinateSpace: 'rendered_page_pixels',
      words: sorted.length,
      wordBoxes
    };
  }).sort((a, b) => a.page - b.page || a.box.top - b.box.top || a.box.left - b.box.left);
}
const SPATIAL_ANNOTATION_RULES = [
  ['dimensions', /\b\d+(?:\.\d+)?\s*(?:mm|cm|m)\b|\b\d+\s*[x×]\s*\d+\b/i],
  ['structural', /\b(?:B|BM|C|COL|F|FOOTING|S|SL|W)-?\s*\d{1,4}[A-Z]?\b|(?:^|[^A-Za-z0-9])(?:\d{1,3}\s*)?[TYØΦ]\s*\d{1,2}(?:\s*[@/\-]\s*\d{2,4})?\b|\b(?:C|M)\s*\d{2,3}\b|\b(?:B|BM|C|S)\d{1,3}\s*[-:]?\s*\d{2,4}\s*[x×]\s*\d{2,4}\b|خرسانة|تسليح|حديد\s*(?:التسليح)?|عمود|جسر|قاعدة/i],
  ['architectural', /\b(?:D|W|WD|SD)-?\d{1,3}\b|\b(?:TILE|CERAMIC|MARBLE|PAINT|PLASTER|FLOOR FINISH|WALL FINISH)\b|بلاط|سيراميك|رخام|دهان|قصارة|باب|شباك/i],
  ['electrical', /\b(?:DB|MDB|SMDB|LP|PP|ELP)-?\d{0,3}\b|\b(?:CABLE|CONDUIT|LIGHTING|SOCKET|OUTLET|EARTH)\b|كهرباء|كابل|إنارة|انارة|مقبس|تأريض/i],
  ['mechanical_hvac', /\b(?:AHU|FCU|FAHU|VAV|VRF|CHW|HVAC)-?\d{0,3}\b|\b(?:DUCT|DIFFUSER|GRILLE|DAMPER|EXHAUST FAN)\b|تكييف|تهوية|مجرى\s*هواء|مروحة/i],
  ['plumbing_drainage', /\b(?:DN|Ø)\s*\d{1,4}\b|\b(?:PPR|UPVC|HDPE|WASTE|SOIL|RAINWATER|DRAIN|CLEANOUT|MANHOLE)\b|صرف\s*صحي|مياه|تغذية|أنبوب|ماسورة|منهل/i],
  ['fire_protection', /\b(?:SPRINKLER|FHC|FIRE HOSE|FIRE HYDRANT|FIRE PUMP|FIRE ALARM|SMOKE DETECTOR)\b|رشاش|مكافحة\s*حريق|إنذار\s*حريق|طفاية/i],
  ['earthworks_levels', /\b(?:EXCAVATION|BACKFILL|COMPACTION|FORMATION LEVEL|EXISTING LEVEL|PROPOSED LEVEL|RL\s*[-+]?\d+(?:\.\d+)?)\b|حفر|ردم|طمم|دمك|منسوب/i]
];
function classifySpatialOcrAnnotations(lines) {
  return lines.map(line => {
    const candidateTypes = SPATIAL_ANNOTATION_RULES
      .filter(([, pattern]) => pattern.test(line.text))
      .map(([type]) => type);
    if (!candidateTypes.length) return null;
    return {
      page: line.page,
      raw: line.text,
      box: line.box,
      coordinateSpace: line.coordinateSpace,
      ocrConfidence: line.confidence,
      candidateTypes,
      status: line.confidence >= 90 ? 'candidate_requires_drawing_context' : 'manual_review_required',
      measurementEligible: false,
      source: 'OCR word boxes; semantic text candidate only'
    };
  }).filter(Boolean).slice(0, 3000);
}
function normalizeEngineeringNumerals(value) {
  const digits = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9' };
  return String(value || '').replace(/[٠-٩۰-۹]/g, digit => digits[digit]).replace(/٫/g, '.');
}
function engineeringNumber(value) {
  const parsed = Number(normalizeEngineeringNumerals(value).replace(/,/g, '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeEngineeringUnit(value) {
  const unit = String(value || '').toLowerCase();
  return ({ 'مم': 'mm', 'سم': 'cm', 'م': 'm' })[unit] || unit;
}
function extractSpatialDimensionCandidates(lines) {
  const candidates = [];
  const number = '[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?';
  const unit = '(?:mm|cm|m|مم|سم|م)';
  const patterns = [
    { kind: 'explicit_length', regex: new RegExp('(' + number + ')\\s*(' + unit + ')(?![\\p{L}])', 'giu'),
      values: m => [engineeringNumber(m[1])], units: m => [normalizeEngineeringUnit(m[2])] },
    { kind: 'dimension_pair', regex: new RegExp('(' + number + ')\\s*[x×]\\s*(' + number + ')(?:\\s*(' + unit + '))?', 'giu'),
      values: m => [engineeringNumber(m[1]), engineeringNumber(m[2])],
      units: m => [m[3] ? normalizeEngineeringUnit(m[3]) : null, m[3] ? normalizeEngineeringUnit(m[3]) : null] }
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line.text))) {
        const raw = clean(match[0]);
        const matchedWords = (line.wordBoxes || []).filter(word =>
          word.start < match.index + match[0].length && word.end > match.index);
        const box = (() => {
          if (!matchedWords.length) return line.box;
          const left = Math.min(...matchedWords.map(word => word.box.left));
          const top = Math.min(...matchedWords.map(word => word.box.top));
          const right = Math.max(...matchedWords.map(word => word.box.left + word.box.width));
          const bottom = Math.max(...matchedWords.map(word => word.box.top + word.box.height));
          return { left, top, width: right - left, height: bottom - top };
        })();
        const values = pattern.values(match);
        const units = pattern.units(match);
        const unitToMm = { mm: 1, cm: 10, m: 1000 };
        const normalizedValuesMm = units.length === values.length && units.every(unit => unit && unitToMm[unit])
          ? values.map((value, index) => value * unitToMm[units[index]])
          : null;
        candidates.push({
          page: line.page,
          raw,
          kind: pattern.kind,
          values,
          units,
          normalizedValuesMm,
          dimensionRole: 'unresolved_callout_not_element_geometry',
          box,
          coordinateSpace: line.coordinateSpace,
          ocrConfidence: line.confidence,
          sourceWordCount: matchedWords.length,
          status: values.every(Number.isFinite) && (pattern.kind === 'explicit_length' || units.every(Boolean))
            ? 'explicit_unit_candidate_requires_drawing_context'
            : 'unit_or_dimension_meaning_unresolved',
          measurementEligible: false,
          source: 'OCR word boxes; unverified dimension text'
        });
      }
    }
  }
  return candidates.slice(0, 1500);
}


function centerOf(box) {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}
function spatialDistance(a, b) {
  const ca = centerOf(a), cb = centerOf(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}
function extractElementTag(text) {
  const match = String(text || '').match(/\b(?:B|BM|C|COL|F|FOOTING|S|SL|W|D|DB|AHU|FCU|VAV|P|MH|FH|SP)-?\s*\d{1,4}[A-Z]?\b/i);
  return match ? clean(match[0]).replace(/\s+/g, '').toUpperCase() : null;
}
function extractReinforcementCallouts(text) {
  const normalized = normalizeEngineeringNumerals(text).replace(/[ØΦ]/g, 'T');
  // Preserve count, diameter, spacing and common distribution hints separately.
  const pattern = /(?:(\d{1,3})\s*)?[TY]\s*(\d{1,2})(?:\s*[@/\-]\s*(\d{2,4}))?/gi;
  const results = [];
  let match;
  while ((match = pattern.exec(normalized))) {
    const barCount = match[1] ? Number(match[1]) : null;
    const diameterMm = Number(match[2]);
    const spacingMm = match[3] ? Number(match[3]) : null;
    if ((barCount !== null && barCount <= 0) || diameterMm < 6 || diameterMm > 50) continue;
    if (spacingMm !== null && (spacingMm < 40 || spacingMm > 2000)) continue;
    const tail = normalized.slice(pattern.lastIndex, pattern.lastIndex + 16);
    const directionMatch = tail.match(/^\s*(EW|EF|E\.W\.|E\.F\.|BOTH\s+WAYS|EACH\s+WAY|EACH\s+FACE)\b/i);
    const directionToken = directionMatch ? directionMatch[1].toUpperCase().replace(/\./g, '') : null;
    const distribution = directionToken === 'EW' || directionToken === 'BOTH WAYS' || directionToken === 'EACH WAY'
      ? 'each_way' : directionToken === 'EF' || directionToken === 'EACH FACE' ? 'each_face' : null;
    results.push({
      raw: clean(match[0]),
      barCount,
      diameterMm,
      spacingMm,
      distribution,
      nominalUnitMassKgPerM: Number((diameterMm * diameterMm / 162).toFixed(4)),
      totalBarLength: null,
      totalSteelMassKg: null,
      status: distribution ? 'reinforcement_distribution_candidate_requires_detail_confirmation' :
        spacingMm !== null ? 'diameter_and_spacing_candidate_length_and_distribution_unverified' :
        barCount !== null ? 'bar_count_and_diameter_candidate_length_and_shape_not_read' :
        'diameter_candidate_count_spacing_and_length_unresolved',
      measurementEligible: false
    });
  }
  return results;
}

function inferElementFamily(tag) {
  if (!tag) return null;
  const prefix = tag.match(/^[A-Z]+/)?.[0] || '';
  const families = {
    B: 'beam', BM: 'beam', C: 'column', COL: 'column',
    F: 'footing', FOOTING: 'footing', S: 'slab_or_structural_mark_unresolved',
    SL: 'slab', W: 'wall', D: 'door_or_detail_mark_unresolved',
    DB: 'distribution_board', AHU: 'air_handling_unit',
    FCU: 'fan_coil_unit', VAV: 'variable_air_volume_unit',
    P: 'pipe_or_pump_mark_unresolved', MH: 'manhole',
    FH: 'fire_hose_or_fire_hydrant_mark_unresolved',
    SP: 'sprinkler_or_special_mark_unresolved'
  };
  return families[prefix] || null;
}
function buildSpatialElementCandidates(lines, dimensions, options = {}) {
  const maxDistancePx = Number.isFinite(options.maxDistancePx) ? options.maxDistancePx : 160;
  const annotations = classifySpatialOcrAnnotations(lines);
  const candidates = annotations.map((annotation, index) => {
    const tag = extractElementTag(annotation.raw);
    const reinforcementCandidates = extractReinforcementCallouts(annotation.raw);
    // Dimension-only OCR annotations are evidence, not elements; exclude them
    // so a callout cannot consume its own association before a beam or column.
    if (!tag && !reinforcementCandidates.length) return null;
    const nearby = dimensions
      .map((dimension, dimensionIndex) => ({
        dimension, dimensionIndex,
        distancePx: dimension.page === annotation.page && dimension.box
          ? spatialDistance(annotation.box, dimension.box) : Infinity
      }))
      .filter(item => item.distancePx <= maxDistancePx)
      .sort((a, b) => a.distancePx - b.distancePx);
    const ambiguous = Boolean(nearby[0] && nearby[1] &&
      Math.abs(nearby[1].distancePx - nearby[0].distancePx) < 20);
    return {
      index, annotation, tag,
      reinforcementCandidates,
      nearby, ambiguous
    };
  }).filter(Boolean);

  // Resolve globally rather than independently per label: a single dimension
  // callout must never be silently counted against multiple drawing elements.
  const assignments = new Map();
  const usedDimensions = new Set();
  const edges = [];
  for (const candidate of candidates) {
    if (candidate.ambiguous) continue;
    for (const item of candidate.nearby) {
      edges.push({ candidateIndex: candidate.index, dimensionIndex: item.dimensionIndex, distancePx: item.distancePx });
    }
  }
  edges.sort((a, b) => a.distancePx - b.distancePx ||
    a.candidateIndex - b.candidateIndex || a.dimensionIndex - b.dimensionIndex);
  for (const edge of edges) {
    if (assignments.has(edge.candidateIndex) || usedDimensions.has(edge.dimensionIndex)) continue;
    assignments.set(edge.candidateIndex, edge);
    usedDimensions.add(edge.dimensionIndex);
  }

  return candidates.map(candidate => {
    const { annotation, tag, nearby, ambiguous } = candidate;
    const assignment = assignments.get(candidate.index);
    const dimension = assignment ? dimensions[assignment.dimensionIndex] : null;
    return {
      page: annotation.page,
      rawLabel: annotation.raw,
      elementTagCandidate: tag,
      elementFamilyCandidate: inferElementFamily(tag),
      reinforcementCandidates: candidate.reinforcementCandidates,
      disciplineCandidates: annotation.candidateTypes,
      labelBox: annotation.box,
      dimensionCandidate: dimension ? {
        raw: dimension.raw,
        kind: dimension.kind,
        values: dimension.values,
        units: dimension.units,
        normalizedValuesMm: dimension.normalizedValuesMm,
        box: dimension.box,
        distancePx: Number(assignment.distancePx.toFixed(2))
      } : null,
      associationStatus: ambiguous ? 'ambiguous_nearby_dimensions' :
        dimension ? 'spatially_associated_candidate' :
        nearby.length ? 'dimension_candidate_already_assigned_or_unresolved' :
        'no_nearby_dimension_candidate',
      reviewStatus: annotation.status,
      measurementEligible: false,
      source: 'OCR text and rendered-page pixel proximity; not verified CAD/BIM geometry'
    };
  }).slice(0, 3000);
}

function analyzePdfDrawingText(extraction, document = {}) {
  if (!extraction || typeof extraction.text !== 'string') {
    throw new TypeError('PDF text extraction result is required');
  }
  const text = extraction.text.slice(0, 250000);
  const lines = text.split(/[\r\n]+/).map(clean).filter(Boolean);
  const sheetNumbers = collect(text,
    /\b(?:DWG|DRAWING|SHEET)\s*(?:NO\.?|NUMBER|#)?\s*[:\-]?\s*([A-Z]{1,5}[-./]?[A-Z0-9.-]{1,24})\b/gi);
  const revisions = collect(text,
    /\b(?:REV(?:ISION)?|ISSUE)\s*[:#\-]?\s*([A-Z0-9]{1,5})\b/gi);
  const scales = collect(text,
    /\bSCALE\s*[:\-]?\s*((?:1\s*:\s*\d+(?:\.\d+)?|AS\s+NOTED|NTS|NOT\s+TO\s+SCALE))\b/gi,
    m => clean(m[1]).replace(/\s+/g, ''));
  const dimensions = [];
  const dimensionPattern = /\b(\d+(?:\.\d+)?)\s*(mm|cm|m)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)(?:\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m))?\b/gi;
  let dm;
  while ((dm = dimensionPattern.exec(text))) {
    dimensions.push({
      raw: clean(dm[0]),
      values: [Number(dm[1]), Number(dm[3]), dm[5] ? Number(dm[5]) : null],
      units: [dm[2].toLowerCase(), dm[4].toLowerCase(), dm[6] ? dm[6].toLowerCase() : null],
      evidence: 'explicit_text_dimension'
    });
  }
  const detailReferences = collect(text,
    /\b(?:DETAIL|SECTION|ELEVATION|TYPICAL)\s*(?:NO\.?|#)?\s*([A-Z]?[0-9]{1,3}[A-Z]?)\b/gi,
    m => m[0]);
  const scheduleMentions = collect(text,
    /\b(DOOR|WINDOW|LIGHTING|LUMINAIRE|EQUIPMENT|FINISH|REBAR|STEEL|PIPE|VALVE|CABLE|FIXTURE)\s+SCHEDULE\b/gi,
    m => m[0]);
  const disciplines = [];
  const disciplineRules = [
    ['structural', /\b(STRUCTURAL|FOUNDATION|REINFORCEMENT|REBAR|CONCRETE)\b/i],
    ['architectural', /\b(ARCHITECTURAL|FLOOR PLAN|DOOR SCHEDULE|WINDOW SCHEDULE|FINISH SCHEDULE)\b/i],
    ['electrical', /\b(ELECTRICAL|LIGHTING|POWER|SINGLE LINE)\b/i],
    ['mechanical', /\b(MECHANICAL|HVAC|DUCTWORK|CHILLED WATER)\b/i],
    ['plumbing', /\b(PLUMBING|SANITARY|DRAINAGE|WATER SUPPLY)\b/i],
    ['fire_protection', /\b(FIRE PROTECTION|FIRE FIGHTING|SPRINKLER)\b/i],
    ['civil_earthworks', /\b(EARTHWORK|GRADING|SITE PLAN|ROADWORK|EXCAVATION)\b/i]
  ];
  for (const [discipline, pattern] of disciplineRules) if (pattern.test(text)) disciplines.push(discipline);

  const titleCandidates = lines.filter(line =>
    line.length >= 5 && line.length <= 120 &&
    /\b(PLAN|LAYOUT|ELEVATION|SECTION|DETAIL|FOUNDATION|ROOF|FLOOR|SITE|SCHEMATIC|DIAGRAM|SCHEDULE)\b/i.test(line)
  ).slice(0, 20);

  const metadata = {
    documentId: document.documentId || null,
    revisionInRegister: document.revision || null,
    sheetInRegister: document.sheetOrPage || null,
    extractedPageCount: Number.isInteger(extraction.pageCount) ? extraction.pageCount : null,
    extractionEngine: extraction.engine || null,
    ocrPerformed: extraction.ocrPerformed === true,
    ocrPageCount: Number.isInteger(extraction.ocrPageCount) ? extraction.ocrPageCount : 0,
    ocrAverageConfidence: Number.isFinite(extraction.ocrAverageConfidence) ? extraction.ocrAverageConfidence : null,
    ocrWordCount: Array.isArray(extraction.ocrWords) ? extraction.ocrWords.length : 0,
    ocrWordEvidence: Array.isArray(extraction.ocrWords) ? extraction.ocrWords.slice(0, 20000).map(word => ({ page: word.page, text: word.text, confidence: word.confidence, box: word.box })) : [],
    ocrSpatialLines: spatialOcrLines(extraction.ocrWords).slice(0, 5000),
    ocrSpatialDimensionCandidates: extractSpatialDimensionCandidates(spatialOcrLines(extraction.ocrWords)),
    spatialEngineeringAnnotations: classifySpatialOcrAnnotations(spatialOcrLines(extraction.ocrWords)),
    spatialElementCandidates: buildSpatialElementCandidates(
      spatialOcrLines(extraction.ocrWords),
      extractSpatialDimensionCandidates(spatialOcrLines(extraction.ocrWords))
    ),
    ocrDimensionCallouts: spatialOcrLines(extraction.ocrWords).filter(line => /\d\s*(?:mm|cm|m)\b|\d\s*[x×]\s*\d/i.test(line.text)).map(line => ({ page: line.page, raw: line.text, box: line.box, confidence: line.confidence, status: line.confidence >= 85 ? 'candidate_requires_drawing_verification' : 'low_confidence_requires_manual_review' })).slice(0, 1000),
    textualSheetNumberCandidates: sheetNumbers,
    textualRevisionCandidates: revisions,
    textualScaleCandidates: scales,
    explicitDimensionCallouts: dimensions,
    detailAndSectionReferenceCandidates: detailReferences,
    scheduleTypeMentions: scheduleMentions,
    disciplineClues: disciplines,
    titleCandidates
  };
  const conflicts = [];
  if (document.revision && revisions.length && !revisions.includes(String(document.revision).toUpperCase())) {
    conflicts.push({ field: 'revision', registerValue: document.revision, extractedCandidates: revisions });
  }
  if (document.sheetOrPage && sheetNumbers.length && !sheetNumbers.includes(String(document.sheetOrPage).toUpperCase())) {
    conflicts.push({ field: 'sheetOrPage', registerValue: document.sheetOrPage, extractedCandidates: sheetNumbers });
  }
  const evidenceCount = sheetNumbers.length + revisions.length + scales.length + dimensions.length +
    detailReferences.length + scheduleMentions.length + titleCandidates.length;
  return {
    status: conflicts.length ? 'text_clues_with_register_conflicts' : evidenceCount ? 'text_clues_found' : 'insufficient_text_clues',
    metadata,
    conflicts,
    evidence: {
      source: extraction.ocrPerformed === true ? 'PDF text extractor and OCR output' : 'PDF text extractor output',
      characterCount: extraction.characterCount ?? text.length,
      evidenceCount,
      confidence: 'unscored_textual_clues_only'
    },
    unresolved: [
      'Text clues are not verified against title-block coordinates or page layout.',
      'Scale candidates are not applied to drawing geometry.',
      'Dimensions are preserved as explicit callouts; they are not assumed to describe the complete drawing extent.',
      'Detail references are not yet resolved to other sheets or viewports.',
      ...(extraction.ocrPerformed === true ? [] : ['Raster-only text requires OCR; OCR was not performed for this analysis.']),
      'No engineering element classification or quantity calculation was performed.'
    ]
  };
}
module.exports = { analyzePdfDrawingText, spatialOcrLines, classifySpatialOcrAnnotations, buildSpatialElementCandidates };
