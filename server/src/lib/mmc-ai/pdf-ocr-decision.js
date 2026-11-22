'use strict';

/**
 * OCR decision for engineering PDFs.
 * A large amount of extracted prose is not proof that dimensions, schedules,
 * reinforcement notes or service callouts were actually extracted.
 */
function countEngineeringSignals(text) {
  const source = String(text || '').replace(/[–—]/g, '-');
  const patterns = [
    /\b\d+(?:\.\d+)?\s*(?:mm|cm|m)\b/gi,
    /\b\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?\b/gi,
    /(?:^|[^A-Z0-9])(?:Y|T|Ø|Φ)\s*\d{1,2}\s*(?:[-/@]\s*\d{2,4})?/gi,
    /\b(?:DN|DIA|Ø)\s*\d{2,4}\b/gi,
    /\b(?:UPVC|PPR|HDPE|REBAR|REINFORC(?:E|ING)|FOUNDATION|FOOTING|SLAB|BEAM|COLUMN|DUCT|CABLE|SPRINKLER)\b/gi
  ];
  let count = 0;
  const matches = [];
  for (const pattern of patterns) {
    const found = source.match(pattern) || [];
    count += found.length;
    matches.push(...found.map(value => value.trim()));
  }
  return { count, matches: [...new Set(matches)].slice(0, 100) };
}

function decideEngineeringOcr({
  nativeText = '',
  nativeWordCount = 0,
  hasPagesWithoutNativeText = false,
  characterCount = 0,
  imageXObjectCount = 0,
  minimumEngineeringSignals = 2
} = {}) {
  const signals = countEngineeringSignals(nativeText);
  const reasons = [];
  if (nativeWordCount < 8) reasons.push('native_text_word_count_below_8');
  if (hasPagesWithoutNativeText) reasons.push('one_or_more_pages_have_sparse_native_text');
  if (characterCount < 40) reasons.push('native_text_character_count_below_40');
  if (imageXObjectCount > 0) reasons.push('page_contains_image_xobjects');
  if (signals.count < minimumEngineeringSignals) reasons.push('engineering_dimensions_or_callouts_not_sufficiently_detected');
  return {
    shouldRunOcr: reasons.length > 0,
    reasons,
    engineeringSignalCount: signals.count,
    engineeringSignals: signals.matches,
    minimumEngineeringSignals
  };
}

module.exports = { countEngineeringSignals, decideEngineeringOcr };
