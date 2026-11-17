'use strict';

/**
 * Schedule-driven MEP device and fixture takeoff.
 * Counts are accepted only from classified symbols or explicit schedules.
 * This module does not infer devices from room area or spacing rules.
 */
const round = value => Number(value.toFixed(6));
const positive = (v, name) => { if (!Number.isFinite(v) || v <= 0) throw new TypeError(name + ' must be greater than zero'); };
const nonNegative = (v, name) => { if (!Number.isFinite(v) || v < 0) throw new TypeError(name + ' must be non-negative'); };

function aggregateScheduleItems(rows, { discipline, itemType } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('schedule rows are required');
  if (typeof discipline !== 'string' || !discipline.trim()) throw new TypeError('discipline is required');
  if (typeof itemType !== 'string' || !itemType.trim()) throw new TypeError('itemType is required');
  const groups = new Map();
  const normalizedRows = rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new TypeError('schedule row ' + index + ' is required');
    if (typeof row.tag !== 'string' || !row.tag.trim()) throw new TypeError('schedule row tag is required');
    if (typeof row.description !== 'string' || !row.description.trim()) throw new TypeError('schedule row description is required');
    if (typeof row.unit !== 'string' || !row.unit.trim()) throw new TypeError('schedule row unit is required');
    positive(row.quantity, 'schedule quantity');
    const specification = row.specification || '';
    const size = row.size || '';
    const key = [row.tag, row.description, specification, size, row.unit].map(v => String(v).trim().toLowerCase()).join('|');
    if (!groups.has(key)) groups.set(key, { tag: row.tag, description: row.description, specification, size, unit: row.unit, quantity: 0, sourceRows: [] });
    const group = groups.get(key);
    group.quantity += row.quantity;
    group.sourceRows.push({ sourceId: row.sourceId || null, sheet: row.sheet || null, location: row.location || null, quantity: row.quantity });
    return { tag: row.tag, quantity: row.quantity, unit: row.unit };
  });
  const items = [...groups.values()].map(item => ({ ...item, quantity: round(item.quantity) }));
  return {
    method: 'classified_symbol_or_schedule_aggregation',
    ruleId: 'MEP-SCHEDULE-ITEM-COUNT',
    ruleVersion: '1.0',
    discipline,
    itemType,
    itemCount: items.length,
    totalQuantity: round(items.reduce((sum, item) => sum + item.quantity, 0)),
    items: items.map((item, index) => ({ itemId: itemType.toUpperCase() + '-' + String(index + 1).padStart(4, '0'), ...item })),
    sourceRows: normalizedRows.length,
    limitations: [
      'Counts must originate from classified drawing symbols or explicit equipment/device schedules.',
      'Do not derive quantities from floor area, occupancy or assumed spacing unless a separate approved design rule explicitly requires it.',
      'Accessories, cabling, containment, valves, supports, wiring and installation materials are separate measured items.',
      'Repeated symbols across plans and schedules must be reconciled by source identity to prevent double counting.'
    ]
  };
}

function calculateElectricalDeviceSchedule(rows) {
  const allowed = new Set(['luminaire', 'switch', 'socket_outlet', 'distribution_board', 'isolator', 'detector', 'data_outlet', 'telephone_outlet', 'earthing_point', 'other']);
  for (const row of rows || []) {
    if (!allowed.has(row?.deviceType)) throw new TypeError('unsupported electrical deviceType');
  }
  return aggregateScheduleItems(rows, { discipline: 'electrical', itemType: 'electrical_device' });
}

function calculatePlumbingFixtureSchedule(rows) {
  const allowed = new Set(['water_closet', 'wash_basin', 'sink', 'shower', 'floor_drain', 'urinal', 'water_heater', 'pump', 'water_tank', 'other']);
  for (const row of rows || []) {
    if (!allowed.has(row?.fixtureType)) throw new TypeError('unsupported plumbing fixtureType');
  }
  return aggregateScheduleItems(rows, { discipline: 'plumbing', itemType: 'plumbing_fixture' });
}

function calculateFireProtectionSchedule(rows) {
  const allowed = new Set(['sprinkler_head', 'hose_reel', 'fire_hydrant', 'fire_extinguisher', 'landing_valve', 'fire_alarm_panel', 'smoke_detector', 'heat_detector', 'flow_switch', 'tamper_switch', 'fire_pump', 'other']);
  for (const row of rows || []) {
    if (!allowed.has(row?.fireItemType)) throw new TypeError('unsupported fireItemType');
  }
  return aggregateScheduleItems(rows, { discipline: 'fire_protection', itemType: 'fire_protection_device' });
}

module.exports = { aggregateScheduleItems, calculateElectricalDeviceSchedule, calculatePlumbingFixtureSchedule, calculateFireProtectionSchedule };
