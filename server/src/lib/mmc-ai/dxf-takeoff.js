'use strict';

/**
 * MMC AI — deterministic DXF geometry takeoff (first engineering kernel).
 *
 * Supports ASCII DXF ENTITIES: LINE, LWPOLYLINE, CIRCLE, ARC.
 * Quantities are calculated from CAD coordinates and the drawing's $INSUNITS.
 * This module deliberately does not use an LLM to invent geometry or scale.
 *
 * Limitations: no blocks/xrefs, SPLINE, HATCH, 3D solids, paper-space viewport
 * transforms, raster drawings, or automatic BOQ classification. Unsupported
 * entities are counted and reported, never silently converted to quantities.
 */
const UNIT_TO_METRE = {
  0: null, 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001,
  5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5,
  10: 0.9144, 11: 1e-10, 12: 1e-9, 13: 1e-6, 14: 0.1,
  15: 10, 16: 100, 17: 1e9, 18: 149597870700, 19: 9.460730472e15,
  20: 3.085677581e16, 21: 0.0003048, 22: 1e-7
};

function parsePairs(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('DXF content is empty.');
  const lines = text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (lines.length % 2 !== 0) throw new Error('Malformed DXF: incomplete group-code pair.');
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new Error('Malformed DXF group code at line ' + (i + 1));
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

function readHeaderUnits(pairs) {
  let inHeader = false, variable = '';
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code === 0 && p.value === 'SECTION') {
      inHeader = pairs[i + 1]?.code === 2 && pairs[i + 1].value === 'HEADER';
    } else if (p.code === 0 && p.value === 'ENDSEC') inHeader = false;
    else if (inHeader && p.code === 9) variable = p.value;
    else if (inHeader && variable === '$INSUNITS' && p.code === 70) return Number(p.value);
  }
  return 0;
}

function entitiesFrom(pairs) {
  let section = '', inEntities = false, current = null;
  const entities = [];
  for (const p of pairs) {
    if (p.code === 0 && p.value === 'SECTION') { section = ''; inEntities = false; current = null; continue; }
    if (p.code === 2 && !section) { section = p.value; inEntities = section === 'ENTITIES'; continue; }
    if (p.code === 0 && p.value === 'ENDSEC') {
      if (current) entities.push(current);
      current = null; inEntities = false; section = ''; continue;
    }
    if (!inEntities) continue;
    if (p.code === 0) {
      if (current) entities.push(current);
      current = { type: p.value, pairs: [] };
    } else if (current) current.pairs.push(p);
  }
  if (current) entities.push(current);
  return entities;
}

function requireCodes(e, codes, label) {
  for (const code of codes) {
    if (!e.pairs.some(p => p.code === code)) {
      throw new Error('Missing required DXF group code ' + code + ' in ' + label + '.');
    }
  }
}
function first(e, code, fallback = 0) {
  const p = e.pairs.find(x => x.code === code);
  return p ? Number(p.value) : fallback;
}
function all(e, code) { return e.pairs.filter(x => x.code === code).map(x => Number(x.value)); }
function layerOf(e) { return e.pairs.find(x => x.code === 8)?.value || '0'; }
function assertFinite(values, label) {
  if (values.some(value => !Number.isFinite(value))) {
    throw new Error('Invalid non-numeric geometry in ' + label + '.');
  }
}
function pointDistance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

function polylineVertices(e) {
  const out = [];
  let current = null;
  for (const p of e.pairs) {
    if (p.code === 10) {
      if (current) out.push(current);
      current = { x: Number(p.value), y: 0 };
    } else if (p.code === 20 && current) current.y = Number(p.value);
    else if (p.code === 42 && current) current.bulge = Number(p.value);
  }
  if (current) out.push(current);
  return out;
}

function polylineMetrics(vertices, closed) {
  let perimeter = 0, area2 = 0, curvedArea = 0;
  const count = vertices.length;
  const edges = closed ? count : Math.max(0, count - 1);
  for (let i = 0; i < edges; i++) {
    const a = vertices[i], b = vertices[(i + 1) % count];
    const chord = pointDistance(a, b);
    perimeter += chord;
    area2 += a.x * b.y - b.x * a.y;
    const bulge = a.bulge || 0;
    if (Math.abs(bulge) > 1e-12 && chord > 0) {
      const theta = 4 * Math.atan(bulge);
      const radius = chord * (1 + bulge * bulge) / (4 * Math.abs(bulge));
      perimeter += radius * Math.abs(theta) - chord;
      curvedArea += radius * radius * (theta - Math.sin(theta)) / 2;
    }
  }
  return { perimeter, area: closed ? Math.abs(area2 / 2 + curvedArea) : null };
}

function takeoffDxf(text, options = {}) {
  const pairs = parsePairs(text);
  const unitCode = readHeaderUnits(pairs);
  const metresPerUnit = options.metresPerUnit ?? UNIT_TO_METRE[unitCode];
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) {
    throw new Error('Drawing units are undefined. Set a verified metresPerUnit scale before measuring.');
  }
  const entities = entitiesFrom(pairs);
  const rows = [];
  const unsupported = {};
  const byLayer = {};
  for (let index = 0; index < entities.length; index++) {
    const e = entities[index], layer = layerOf(e);
    const row = { entity: e.type, entityIndex: index, layer };
    let quantity = null, unit = null;
    if (e.type === 'LINE') {
      requireCodes(e, [10, 20, 11, 21], 'LINE entity ' + index);
      const a = { x: first(e, 10), y: first(e, 20) }, b = { x: first(e, 11), y: first(e, 21) };
      assertFinite([a.x, a.y, b.x, b.y], 'LINE entity ' + index);
      quantity = pointDistance(a, b) * metresPerUnit; unit = 'm';
    } else if (e.type === 'LWPOLYLINE') {
      requireCodes(e, [10, 20], 'LWPOLYLINE entity ' + index);
      const vertices = polylineVertices(e), closed = (first(e, 70) & 1) === 1;
      assertFinite(vertices.flatMap(v => [v.x, v.y, v.bulge ?? 0]), 'LWPOLYLINE entity ' + index);
      if (vertices.length < 2) { unsupported[e.type] = (unsupported[e.type] || 0) + 1; continue; }
      const m = polylineMetrics(vertices, closed);
      row.closed = closed;
      row.length_m = m.perimeter * metresPerUnit;
      if (closed) row.area_m2 = m.area * metresPerUnit * metresPerUnit;
      quantity = row.length_m; unit = 'm';
    } else if (e.type === 'CIRCLE') {
      requireCodes(e, [10, 20, 40], 'CIRCLE entity ' + index);
      const radius = first(e, 40);
      assertFinite([radius], 'CIRCLE entity ' + index);
      if (radius < 0) throw new Error('Invalid negative circle radius at entity ' + index);
      row.radius_m = radius * metresPerUnit;
      row.circumference_m = 2 * Math.PI * row.radius_m;
      row.area_m2 = Math.PI * row.radius_m * row.radius_m;
      quantity = row.circumference_m; unit = 'm';
    } else if (e.type === 'ARC') {
      requireCodes(e, [10, 20, 40, 50, 51], 'ARC entity ' + index);
      const radius = first(e, 40), start = first(e, 50), end = first(e, 51);
      assertFinite([radius, start, end], 'ARC entity ' + index);
      if (radius < 0) throw new Error('Invalid negative arc radius at entity ' + index);
      let sweep = (end - start) % 360;
      if (sweep < 0) sweep += 360;
      row.radius_m = radius * metresPerUnit;
      quantity = radius * sweep * Math.PI / 180 * metresPerUnit; unit = 'm';
      row.sweep_degrees = sweep;
    } else {
      unsupported[e.type] = (unsupported[e.type] || 0) + 1;
      continue;
    }
    row.quantity = quantity; row.unit = unit;
    rows.push(row);
    const agg = byLayer[layer] || (byLayer[layer] = { entities: 0, length_m: 0, area_m2: 0 });
    agg.entities++;
    if (unit === 'm') agg.length_m += quantity;
    if (row.area_m2) agg.area_m2 += row.area_m2;
  }
  return {
    engine: 'mmc-dxf-geometry-0.1',
    source: 'ASCII DXF ENTITIES',
    units: { insunits: unitCode, metresPerUnit },
    summary: {
      supportedEntities: rows.length,
      unsupportedEntities: Object.values(unsupported).reduce((a, b) => a + b, 0),
      totalLength_m: rows.reduce((s, r) => s + (r.quantity || 0), 0),
      totalClosedArea_m2: rows.reduce((s, r) => s + (r.area_m2 || 0), 0)
    },
    byLayer, unsupported, rows,
    limitations: ['No block or xref expansion', 'No hatch or spline area extraction', 'No automatic drawing-scale inference', 'No BOQ classification', 'Requires engineer review before contractual use']
  };
}

module.exports = { takeoffDxf, parsePairs, readHeaderUnits, entitiesFrom, polylineMetrics, UNIT_TO_METRE };
