'use strict';

const { countEngineeringSignals } = require('./pdf-ocr-decision');

/**
 * Select the spatial text stream that actually contains engineering callouts.
 * Native PDF text often contains title-block prose while dimensions/rebar notes
 * are rasterized; word count alone must not suppress spatial OCR evidence.
 */
function chooseSpatialTextEvidence({ nativeLines = [], ocrLines = [] } = {}) {
  const nativeText = nativeLines.map(line => line.text || '').join('\n');
  const ocrText = ocrLines.map(line => line.text || '').join('\n');
  const nativeSignals = countEngineeringSignals(nativeText);
  const ocrSignals = countEngineeringSignals(ocrText);
  const useOcr = ocrLines.length > 0 && ocrSignals.count > nativeSignals.count;
  const selected = useOcr ? ocrLines : nativeLines;
  return {
    lines: selected,
    source: useOcr ? 'tesseract_ocr_word_boxes' : nativeLines.length ? 'native_pdf_text_bbox' : null,
    decision: useOcr ? 'ocr_has_more_engineering_signals' :
      nativeLines.length ? 'native_text_retained' : ocrLines.length ? 'ocr_fallback_no_native_lines' : 'no_spatial_text',
    native: { lineCount: nativeLines.length, engineeringSignalCount: nativeSignals.count, signals: nativeSignals.matches },
    ocr: { lineCount: ocrLines.length, engineeringSignalCount: ocrSignals.count, signals: ocrSignals.matches }
  };
}

module.exports = { chooseSpatialTextEvidence };
