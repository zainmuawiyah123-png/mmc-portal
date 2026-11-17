'use strict';

/**
 * Schedule- and surface-based finishing and equipment takeoff kernels.
 * Geometry and classifications must be extracted from approved schedules,
 * coordinated models or measured drawing evidence before calling these.
 */
const round = value => Number(value.toFixed(6));
const positive = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(label + ' must be a finite number greater than zero');
};
const nonNegative = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(label + ' must be a finite non-negative number');
};

function calculateFinishAreas(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.length === 0) throw new TypeError('finish surfaces are required');
  const totals = {};
  const rows = surfaces.map((surface, index) => {
    if (!surface || typeof surface.finishCode !== 'string' || !surface.finishCode.trim()) throw new TypeError('surface ' + index + ' requires finishCode');
    positive(surface.grossAreaM2, 'grossAreaM2');
    const deductions = Array.isArray(surface.deductionsM2) ? surface.deductionsM2 : [];
    const deductedArea = deductions.reduce((sum, area, deductionIndex) => {
      nonNegative(area, 'deductionsM2[' + deductionIndex + ']');
      return sum + area;
    }, 0);
    if (deductedArea > surface.grossAreaM2 + 1e-9) throw new RangeError('finish deductions cannot exceed gross area');
    const netArea = surface.grossAreaM2 - deductedArea;
    const coats = surface.coats === undefined ? 1 : surface.coats;
    if (!Number.isInteger(coats) || coats <= 0) throw new TypeError('coats must be a positive integer');
    const measuredArea = netArea * (surface.measureByCoats ? coats : 1);
    const key = surface.finishCode + '|' + (surface.finishType || 'unspecified') + '|' + (surface.unit || 'm2');
    totals[key] = (totals[key] || 0) + measuredArea;
    return {
      surfaceId: surface.surfaceId || null,
      finishCode: surface.finishCode,
      finishType: surface.finishType || null,
      grossAreaM2: round(surface.grossAreaM2),
      deductionsM2: round(deductedArea),
      netAreaM2: round(netArea),
      coats,
      measuredAreaM2: round(measuredArea),
      unit: surface.unit || 'm2'
    };
  });
  return {
    method: 'classified_finish_surface_area',
    ruleId: 'FINISH-SURFACE-NET-AREA',
    ruleVersion: '1.0',
    formula: 'Net finish area = gross measured surface area − explicit deductions; coat multiplier only when measurement basis requires it',
    rows,
    totalsByFinish: Object.entries(totals).map(([key, quantity]) => ({ key, quantity: round(quantity) })),
    limitations: ['Surface extents and finish codes must come from finish schedules, elevations, sections or coordinated model data.', 'Paint coat consumption and material procurement quantities are not the same as measured BOQ surface area.', 'Skirting, reveals, returns, trims, wastage and substrate preparation are separate items unless the contract measurement rule explicitly includes them.']
  };
}

function countScheduledItems(items, { category } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('scheduled items are required');
  if (typeof category !== 'string' || !category.trim()) throw new TypeError('category is required');
  const totals = {};
  const rows = items.map((item, index) => {
    if (!item || typeof item.itemCode !== 'string' || !item.itemCode.trim()) throw new TypeError('item ' + index + ' requires itemCode');
    if (!Number.isInteger(item.count) || item.count < 0) throw new TypeError('item count must be a non-negative integer');
    const key = item.itemCode + '|' + (item.specification || 'unspecified');
    totals[key] = (totals[key] || 0) + item.count;
    return { itemCode: item.itemCode, specification: item.specification || null, count: item.count, scheduleRef: item.scheduleRef || null, location: item.location || null };
  });
  return {
    method: 'explicit_schedule_item_count',
    ruleId: category.toUpperCase().replace(/[^A-Z0-9]+/g, '-') + '-SCHEDULE-COUNT',
    ruleVersion: '1.0',
    formula: 'Count = sum of explicitly listed schedule quantities grouped by item code and specification',
    category,
    rows,
    totalsByItem: Object.entries(totals).map(([key, count]) => ({ key, count })),
    limitations: ['Counts only items explicitly present in the supplied schedule.', 'The schedule must be checked against plans, schematics and project scope to identify omissions or superseded revisions.']
  };
}

module.exports = { calculateFinishAreas, countScheduledItems };
