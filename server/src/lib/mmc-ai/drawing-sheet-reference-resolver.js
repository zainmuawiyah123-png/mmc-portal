'use strict';

/**
 * Cross-sheet register resolver for extracted drawing references.
 * Resolves only exact, unique sheet-number matches. It does not infer a
 * destination sheet from drawing similarity or fabricate missing sheets.
 */
function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}
function buildDrawingSheetRegister(sheets) {
  if (!Array.isArray(sheets)) throw new TypeError('sheets must be an array');
  const entries = [];
  const byNumber = new Map();
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== 'object') throw new TypeError('Each sheet entry must be an object');
    const documentId = String(sheet.documentId || '').trim();
    const revision = String(sheet.revision || '').trim();
    const sheetNumber = normalizeCode(sheet.sheetNumber);
    if (!documentId || !revision || !sheetNumber) {
      throw new TypeError('Every sheet requires documentId, revision and sheetNumber');
    }
    const entry = { documentId, revision, sheetNumber, title: sheet.title || null, references: Array.isArray(sheet.references) ? sheet.references : [] };
    entries.push(entry);
    const matches = byNumber.get(sheetNumber) || [];
    matches.push(entry);
    byNumber.set(sheetNumber, matches);
  }
  return { entries, byNumber };
}
function resolveDrawingReferences(sheets) {
  const register = buildDrawingSheetRegister(sheets);
  const links = [];
  const unresolved = [];
  for (const source of register.entries) {
    const references = Array.isArray(source.references) ? source.references : [];
    for (const reference of references) {
      const raw = typeof reference === 'string' ? reference : reference && reference.sheetNumber;
      const targetCode = normalizeCode(raw);
      if (!targetCode) {
        unresolved.push({ source, reference, reason: 'reference_has_no_sheet_number' });
        continue;
      }
      const matches = register.byNumber.get(targetCode) || [];
      if (matches.length === 0) {
        unresolved.push({ source, reference: targetCode, reason: 'referenced_sheet_not_found' });
      } else if (matches.length > 1) {
        unresolved.push({ source, reference: targetCode, reason: 'referenced_sheet_is_ambiguous', candidateDocumentIds: matches.map(item => item.documentId) });
      } else {
        links.push({
          from: { documentId: source.documentId, revision: source.revision, sheetNumber: source.sheetNumber },
          to: { documentId: matches[0].documentId, revision: matches[0].revision, sheetNumber: matches[0].sheetNumber },
          reference: targetCode,
          status: 'resolved_exact_sheet_number'
        });
      }
    }
  }
  return {
    status: unresolved.length ? (links.length ? 'partially_resolved' : 'unresolved_references') : 'all_references_resolved',
    sheetCount: register.entries.length,
    linkCount: links.length,
    unresolvedCount: unresolved.length,
    links,
    unresolved,
    limitations: [
      'Only exact sheet-number matches are resolved.',
      'Detail bubbles, viewport coordinates, discipline context and revision supersession are not interpreted.',
      'A unique sheet-number match does not prove that the referenced detail is present on that sheet.'
    ]
  };
}
module.exports = { buildDrawingSheetRegister, resolveDrawingReferences };
