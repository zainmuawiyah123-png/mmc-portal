'use strict';

/** Builds a truthful layer summary from persisted DXF takeoff rows. */
function summarizeTakeoffLayers(items) {
  if (!Array.isArray(items)) throw new TypeError('takeoff items must be an array');
  const layers = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new TypeError('takeoff item must be an object');
    const name = typeof item.layer_name === 'string' && item.layer_name.trim()
      ? item.layer_name.trim()
      : (typeof item.layer === 'string' && item.layer.trim() ? item.layer.trim() : '0');
    const key = name.toLocaleLowerCase('en-US');
    const row = layers.get(key) || { name, entityCount: 0, entities: {}, lengths_m: 0, areas_m2: 0, units: {} };
    row.entityCount++;
    const type = String(item.entity_type || item.entity || 'UNKNOWN');
    row.entities[type] = (row.entities[type] || 0) + 1;
    const detail = item.detail && typeof item.detail === 'object' ? item.detail : item;
    if (Number.isFinite(Number(detail.length_m))) row.lengths_m += Number(detail.length_m);
    if (Number.isFinite(Number(detail.area_m2))) row.areas_m2 += Number(detail.area_m2);
    if (typeof item.unit === 'string') row.units[item.unit] = (row.units[item.unit] || 0) + 1;
    layers.set(key, row);
  }
  return [...layers.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(row=>({
    ...row, id: 'native:' + row.name.toLocaleLowerCase('en-US'), lengths_m: Number(row.lengths_m.toFixed(6)), areas_m2: Number(row.areas_m2.toFixed(6)),
    source: 'native_dxf_layer', classification: null, reviewRequired: true
  }));
}
module.exports = { summarizeTakeoffLayers };
