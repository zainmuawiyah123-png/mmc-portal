'use strict';

const { createQuantityRecord } = require('./quantity-record');

/**
 * Connect a deterministic measurement result to the canonical auditable
 * quantity model. The caller must explicitly choose the quantity field,
 * unit, discipline, system and source drawing references.
 */
function quantityRecordFromMeasurement({
  id, projectId, discipline, system, description, unit, quantity,
  measurement, sources, reviewState = 'measured_ready_for_review',
  assumption, missingInformation, notApplicableReason,
  zone, level, grid, elementRefs, duplicateGroup, notes
} = {}) {
  if (!measurement || typeof measurement !== 'object') throw new TypeError('measurement result is required');
  if (typeof measurement.method !== 'string' || !measurement.method.trim()) throw new TypeError('measurement.method is required');
  if (typeof measurement.ruleId !== 'string' || !measurement.ruleId.trim()) throw new TypeError('measurement.ruleId is required');
  if (typeof measurement.ruleVersion !== 'string' || !measurement.ruleVersion.trim()) throw new TypeError('measurement.ruleVersion is required');
  if (typeof measurement.formula !== 'string' || !measurement.formula.trim()) throw new TypeError('measurement.formula is required');
  const inputs = Array.isArray(measurement.inputs) ? measurement.inputs : [];
  if (!inputs.length) throw new TypeError('measurement must retain its explicit calculation inputs');
  return createQuantityRecord({
    id, projectId, discipline, system, description, unit, quantity, reviewState,
    sources,
    assumption, missingInformation, notApplicableReason,
    location: { zone: zone || null, level: level || null, grid: grid || null },
    elementRefs: Array.isArray(elementRefs) ? [...elementRefs] : [],
    duplicateGroup: duplicateGroup || null,
    notes: notes || null,
    derivation: {
      method: measurement.method === 'average_end_area' || measurement.method === 'prismoidal' ||
        measurement.method === 'rectangular_prism_with_explicit_void_deductions' ||
        measurement.method === 'bar_bending_schedule_theoretical_unit_weight' ||
        measurement.method === 'classified_wall_area_with_opening_deductions' ||
        measurement.method === 'straight_rectangular_duct_external_surface' ||
        measurement.method === 'measured_route_segments_with_explicit_allowance' ||
        measurement.method === 'classified_finish_surface_area' ||
        measurement.method === 'explicit_schedule_item_count'
        ? 'rule_based_calculation'
        : 'manual_entry',
      ruleId: measurement.ruleId,
      ruleVersion: measurement.ruleVersion,
      formula: measurement.formula,
      inputs: inputs.map(input => ({ ...input })),
      measurementMethod: measurement.method
    }
  });
}

module.exports = { quantityRecordFromMeasurement };
