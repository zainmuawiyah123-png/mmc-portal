'use strict';

const { createQuantityRecord } = require('./quantity-record');

/**
 * Connect deterministic measurement output to the canonical auditable
 * quantity model. Explicit source drawing references remain mandatory.
 */
function quantityRecordFromMeasurement({
  id, projectId, discipline, system, description, unit, quantity,
  measurement, sources, reviewState,
  assumption, missingInformation, notApplicableReason,
  zone, level, grid, elementRefs, duplicateGroup, notes
} = {}) {
  if (!measurement || typeof measurement !== 'object') throw new TypeError('measurement result is required');
  for (const field of ['method', 'ruleId', 'ruleVersion', 'formula']) {
    if (typeof measurement[field] !== 'string' || !measurement[field].trim()) {
      throw new TypeError('measurement.' + field + ' is required');
    }
  }

  // Kernels commonly return a structured input object; retain every named
  // input instead of rejecting it or flattening away nested evidence.
  let inputs;
  if (Array.isArray(measurement.inputs)) inputs = measurement.inputs.map(input => ({ ...input }));
  else if (measurement.inputs && typeof measurement.inputs === 'object') {
    inputs = Object.entries(measurement.inputs).map(([field, value]) => ({ field, value }));
  } else inputs = [];
  if (!inputs.length) throw new TypeError('measurement must retain its explicit calculation inputs');

  if (measurement.measurementEligible === false && reviewState === 'approved') {
    throw new TypeError('measurement is not eligible for approval; engineering review and source verification are required');
  }
  const effectiveReviewState = reviewState || (
    measurement.measurementEligible === false
      ? 'measured_incomplete_evidence'
      : 'measured_ready_for_review'
  );

  return createQuantityRecord({
    id, projectId, discipline, system, description, unit, quantity,
    reviewState: effectiveReviewState,
    sources,
    assumption, missingInformation, notApplicableReason,
    location: { zone: zone || null, level: level || null, grid: grid || null },
    elementRefs: Array.isArray(elementRefs) ? [...elementRefs] : [],
    duplicateGroup: duplicateGroup || null,
    notes: notes || null,
    derivation: {
      method: measurement.method === 'explicit_schedule_item_count'
        ? 'schedule_takeoff'
        : measurement.method === 'measured_route_segments_with_explicit_allowance'
          ? 'route_trace'
          : measurement.method === 'bim_element_takeoff'
            ? 'bim_element_takeoff'
            : measurement.method === 'cad_geometry'
              ? 'cad_geometry'
              : 'rule_based_calculation',
      ruleId: measurement.ruleId,
      ruleVersion: measurement.ruleVersion,
      formula: measurement.formula,
      inputs,
      measurementMethod: measurement.method
    }
  });
}

module.exports = { quantityRecordFromMeasurement };
