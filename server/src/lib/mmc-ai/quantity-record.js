'use strict';

/**
 * Canonical, discipline-neutral quantity record contract.
 * This module validates evidence and derivation metadata; it does not infer
 * engineering quantities from drawing dimensions.
 */
const REVIEW_STATES = Object.freeze([
  'measured_ready_for_review',
  'measured_incomplete_evidence',
  'provisional_assumption',
  'not_measurable_missing_information',
  'not_applicable_with_evidence',
  'conflict_requires_resolution',
  'approved'
]);
const DERIVATION_METHODS = Object.freeze([
  'schedule_takeoff', 'bim_element_takeoff', 'cad_geometry',
  'route_trace', 'rule_based_calculation', 'manual_entry'
]);
const UNITS = Object.freeze([
  'm', 'm2', 'm3', 'mm', 'cm', 'kg', 't', 'nr', 'item', 'set',
  'point', 'outlet', ' L/s', 'kW', 'kVA', 'm3/h', 'kg/m2'
]);

function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function finiteNonNegative(value) { return Number.isFinite(value) && value >= 0; }

function validateQuantityRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['quantity record must be an object'] };
  }
  for (const field of ['id', 'projectId', 'discipline', 'system', 'description', 'unit', 'reviewState']) {
    if (!nonBlank(record[field])) errors.push(field + ' is required');
  }
  if (record.unit && !UNITS.includes(record.unit)) errors.push('unit is not in the supported canonical unit list');
  if (record.reviewState && !REVIEW_STATES.includes(record.reviewState)) errors.push('reviewState is not supported');
  if (record.quantity !== undefined && !finiteNonNegative(record.quantity)) errors.push('quantity must be a finite non-negative number');
  if (record.reviewState === 'approved' && !finiteNonNegative(record.quantity)) errors.push('approved quantity requires a numeric quantity');
  if (record.reviewState === 'approved' && !record.derivation) errors.push('approved quantity requires derivation');
  if (record.derivation) {
    const d = record.derivation;
    if (!DERIVATION_METHODS.includes(d.method)) errors.push('derivation.method is not supported');
    if (!nonBlank(d.ruleId)) errors.push('derivation.ruleId is required');
    if (!nonBlank(d.formula)) errors.push('derivation.formula is required');
    if (!Array.isArray(d.inputs) || d.inputs.length === 0) errors.push('derivation.inputs must contain at least one evidenced input');
    if (!nonBlank(d.ruleVersion)) errors.push('derivation.ruleVersion is required');
  }
  if (!Array.isArray(record.sources) || record.sources.length === 0) errors.push('at least one source reference is required');
  else record.sources.forEach((source, index) => {
    if (!source || !nonBlank(source.documentId)) errors.push('sources[' + index + '].documentId is required');
    if (!source || !nonBlank(source.revision)) errors.push('sources[' + index + '].revision is required');
    if (!source || !nonBlank(source.sheetOrPage)) errors.push('sources[' + index + '].sheetOrPage is required');
  });
  if (record.reviewState === 'provisional_assumption' && !nonBlank(record.assumption)) errors.push('provisional quantity requires an explicit assumption');
  if (record.reviewState === 'not_measurable_missing_information' && !nonBlank(record.missingInformation)) errors.push('missing-information state requires a description of what is missing');
  if (record.reviewState === 'not_applicable_with_evidence' && !nonBlank(record.notApplicableReason)) errors.push('not-applicable state requires evidence-based reason');
  return { valid: errors.length === 0, errors };
}

function createQuantityRecord(input) {
  const record = {
    ...input,
    sources: Array.isArray(input && input.sources) ? input.sources.map(source => ({ ...source })) : [],
    derivation: input && input.derivation ? {
      ...input.derivation,
      inputs: Array.isArray(input.derivation.inputs) ? input.derivation.inputs.map(item => ({ ...item })) : []
    } : null
  };
  const validation = validateQuantityRecord(record);
  if (!validation.valid) {
    const error = new TypeError('Invalid MMC AI quantity record: ' + validation.errors.join('; '));
    error.validationErrors = validation.errors;
    throw error;
  }
  return record;
}

function summarizeQuantityRecords(records = []) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const counts = Object.fromEntries(REVIEW_STATES.map(state => [state, 0]));
  const byDiscipline = {};
  for (const record of records) {
    const result = validateQuantityRecord(record);
    if (!result.valid) throw new TypeError('Invalid quantity record ' + (record && record.id || '<unknown>') + ': ' + result.errors.join('; '));
    counts[record.reviewState] += 1;
    byDiscipline[record.discipline] = (byDiscipline[record.discipline] || 0) + 1;
  }
  return {
    recordCount: records.length,
    countsByReviewState: counts,
    countsByDiscipline: byDiscipline,
    approvedQuantityCount: records.filter(record => record.reviewState === 'approved').length,
    note: 'Counts only; quantities with different units or measurement bases are never added together.'
  };
}

module.exports = { REVIEW_STATES, DERIVATION_METHODS, UNITS, validateQuantityRecord, createQuantityRecord, summarizeQuantityRecords };
