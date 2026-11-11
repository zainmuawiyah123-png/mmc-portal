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
module.exports = { analyzePdfDrawingText };
