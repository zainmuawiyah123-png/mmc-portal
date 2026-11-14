'use strict';

/**
 * MMC AI — deterministic DXF geometry takeoff (first engineering kernel).
 *
 * Supports ASCII DXF ENTITIES: LINE, 2D POLYLINE/LWPOLYLINE, CIRCLE, ARC.
 * Quantities are calculated from CAD coordinates and the drawing's $INSUNITS.
 * This module deliberately does not use an LLM to invent geometry or scale.
 *
 * Limitations: no xrefs, SPLINE, HATCH, 3D solids, paper-space viewport
 * transforms, raster drawings, nested/array INSERTs, or automatic BOQ classification. Unsupported
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


/**
 * Reassembles legacy POLYLINE -> VERTEX... -> SEQEND sequences.
 * Only planar 2D polylines with explicit vertex coordinates are converted.
 * 3D, mesh, polyface and fitted/spline vertices remain unsupported.
 */
function normalizeClassicPolylines(entities) {
  const normalized = [], unsupported = {};
  const mark = (name) => { unsupported[name] = (unsupported[name] || 0) + 1; };
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity.type !== 'POLYLINE') {
      if (entity.type === 'VERTEX' || entity.type === 'SEQEND') {
        mark('ORPHAN_' + entity.type);
      } else normalized.push(entity);
      continue;
    }

    const flags = first(entity, 70, 0);
    const vertices = [];
    let foundEnd = false, malformed = false;
    while (i + 1 < entities.length) {
      const next = entities[i + 1];
      if (next.type === 'SEQEND') { i++; foundEnd = true; break; }
      if (next.type !== 'VERTEX') break;
      i++;
      const vertexFlags = first(next, 70, 0);
      if ((vertexFlags & (1 | 8 | 16 | 32 | 64 | 128)) !== 0) malformed = true;
      const x = first(next, 10, NaN), y = first(next, 20, NaN), bulge = first(next, 42, 0);
      if (![x, y, bulge].every(Number.isFinite)) malformed = true;
      vertices.push({ x, y, bulge });
    }

    const unsupportedMode = (flags & (2 | 4 | 8 | 16 | 64)) !== 0;
    if (unsupportedMode || malformed || !foundEnd || vertices.length < 2) {
      mark(unsupportedMode ? 'POLYLINE_3D_MESH_OR_FITTED_UNSUPPORTED' : 'POLYLINE_INVALID_OR_INCOMPLETE');
      continue;
    }
    const pairs = [];
    const layer = entity.pairs.find(p => p.code === 8);
    if (layer) pairs.push({ code: 8, value: layer.value });
    pairs.push({ code: 70, value: String(flags & 1) });
    for (const vertex of vertices) {
      pairs.push({ code: 10, value: String(vertex.x) }, { code: 20, value: String(vertex.y) });
      if (vertex.bulge !== 0) pairs.push({ code: 42, value: String(vertex.bulge) });
    }
    normalized.push({ type: 'LWPOLYLINE', pairs, legacyType: 'POLYLINE' });
  }
  return { entities: normalized, unsupported };
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
      if (current) {
        if (!current.hasY) throw new Error('Missing Y coordinate in LWPOLYLINE vertex.');
        out.push({ x: current.x, y: current.y, bulge: current.bulge });
      }
      current = { x: Number(p.value), y: null, hasY: false, bulge: 0 };
    } else if (p.code === 20 && current) {
      if (current.hasY) throw new Error('Duplicate Y coordinate in LWPOLYLINE vertex.');
      current.y = Number(p.value); current.hasY = true;
    } else if (p.code === 42 && current) current.bulge = Number(p.value);
  }
  if (current) {
    if (!current.hasY) throw new Error('Missing Y coordinate in LWPOLYLINE vertex.');
    out.push({ x: current.x, y: current.y, bulge: current.bulge });
  }
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


function blocksFrom(pairs) {
  const blocks = new Map();
  let section = '', block = null, entity = null, readingHeader = false;
  const flushEntity = () => { if (block && entity) block.entities.push(entity); entity = null; };
  for (const p of pairs) {
    if (p.code === 0 && p.value === 'SECTION') { flushEntity(); section = ''; continue; }
    if (p.code === 2 && !section) { section = p.value; continue; }
    if (section !== 'BLOCKS') continue;
    if (p.code === 0 && p.value === 'ENDSEC') {
      flushEntity();
      if (block) blocks.set(block.name, block);
      block = null; section = ''; continue;
    }
    if (p.code === 0 && p.value === 'BLOCK') {
      flushEntity();
      if (block) blocks.set(block.name, block);
      block = { name: '', baseX: 0, baseY: 0, entities: [] };
      readingHeader = true; continue;
    }
    if (p.code === 0 && p.value === 'ENDBLK') {
      flushEntity();
      if (block?.name) blocks.set(block.name, block);
      block = null; readingHeader = false; continue;
    }
    if (!block) continue;
    if (p.code === 0) {
      flushEntity();
      entity = { type: p.value, pairs: [] };
      readingHeader = false;
    } else if (readingHeader && p.code === 2) block.name = p.value;
    else if (readingHeader && p.code === 10) block.baseX = Number(p.value);
    else if (readingHeader && p.code === 20) block.baseY = Number(p.value);
    else if (entity) entity.pairs.push(p);
  }
  flushEntity();
  if (block?.name) blocks.set(block.name, block);
  return blocks;
}

function transformBlockEntity(entity, block, insert, scale, rotation) {
  const radians = rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const ix = first(insert, 10), iy = first(insert, 20);
  const layer = layerOf(insert);
  const transform = (x, y) => {
    const dx = (x - block.baseX) * scale, dy = (y - block.baseY) * scale;
    return { x: ix + dx * cos - dy * sin, y: iy + dx * sin + dy * cos };
  };
  const pairs = entity.pairs.map(p => ({ ...p }));
  const set = (code, value) => {
    const p = pairs.find(x => x.code === code);
    if (p) p.value = String(value);
  };
  if (entity.type === 'LINE') {
    requireCodes(entity, [10,20,11,21], 'block LINE');
    const a = transform(first(entity,10), first(entity,20));
    const b = transform(first(entity,11), first(entity,21));
    set(10,a.x); set(20,a.y); set(11,b.x); set(21,b.y);
  } else if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    requireCodes(entity, entity.type === 'ARC' ? [10,20,40,50,51] : [10,20,40], 'block ' + entity.type);
    const sourceCenter = [first(entity,10), first(entity,20)];
    assertFinite(sourceCenter, 'block ' + entity.type + ' center');
    const c = transform(sourceCenter[0], sourceCenter[1]);
    set(10,c.x); set(20,c.y); set(40,first(entity,40)*scale);
    if (entity.type === 'ARC') {
      set(50,first(entity,50)+rotation); set(51,first(entity,51)+rotation);
    }
  } else if (entity.type === 'LWPOLYLINE') {
    const vertices = polylineVertices(entity);
    let vertexIndex = 0;
    for (const p of pairs) {
      if (p.code === 10) {
        const point = transform(vertices[vertexIndex].x, vertices[vertexIndex].y);
        p.value = String(point.x);
      } else if (p.code === 20) {
        const point = transform(vertices[vertexIndex].x, vertices[vertexIndex].y);
        p.value = String(point.y); vertexIndex++;
      }
    }
  }
  const childLayer = entity.pairs.find(p => p.code === 8)?.value || '0';
  if (childLayer === '0') {
    const layerPair = pairs.find(p => p.code === 8);
    if (layerPair) layerPair.value = layer;
    else pairs.unshift({ code: 8, value: layer });
  }
  return { type: entity.type, pairs, blockName: block.name };
}

function expandBlockInserts(entities, blocks) {
  const expanded = [], unsupported = {};
  const mark = name => { unsupported[name] = (unsupported[name] || 0) + 1; };
  for (const entity of entities) {
    if (entity.type !== 'INSERT') { expanded.push(entity); continue; }
    requireCodes(entity, [2, 10, 20], 'INSERT entity');
    const name = entity.pairs.find(p => p.code === 2)?.value;
    const block = blocks.get(name);
    if (!block) { mark('INSERT_MISSING_BLOCK'); continue; }
    const sx = first(entity,41,1), sy = first(entity,42,1), sz = first(entity,43,1);
    const columns = first(entity,70,1), rows = first(entity,71,1);
    const rotation = first(entity,50,0);
    if (columns !== 1 || rows !== 1) { mark('INSERT_ARRAY_UNSUPPORTED'); continue; }
    if (![sx,sy,sz,rotation].every(Number.isFinite) || sx <= 0 || sy <= 0 || sz <= 0 || Math.abs(sx-sy)>1e-9) {
      mark('INSERT_UNSUPPORTED_SCALE'); continue;
    }
    if (block.entities.some(e => e.type === 'INSERT')) { mark('INSERT_NESTED_BLOCK'); continue; }
    for (const child of block.entities) expanded.push(transformBlockEntity(child, block, entity, sx, rotation));
  }
  return { entities: expanded, unsupported };
}

function takeoffDxf(text, options = {}) {
  const pairs = parsePairs(text);
  const unitCode = readHeaderUnits(pairs);
  const metresPerUnit = options.metresPerUnit ?? UNIT_TO_METRE[unitCode];
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) {
    throw new Error('Drawing units are undefined. Set a verified metresPerUnit scale before measuring.');
  }
  const sourceEntities = entitiesFrom(pairs);
  const classic = normalizeClassicPolylines(sourceEntities);
  const blockExpansion = expandBlockInserts(classic.entities, blocksFrom(pairs));
  const entities = blockExpansion.entities;
  const rows = [];
  const unsupported = { ...classic.unsupported, ...blockExpansion.unsupported };
  const byLayer = {};
  for (let index = 0; index < entities.length; index++) {
    const e = entities[index], layer = layerOf(e);
    const row = { entity: e.type, entityIndex: index, layer };
    if (e.blockName) row.sourceBlock = e.blockName;
    let quantity = null, unit = null;
    if (e.type === 'LINE') {
      requireCodes(e, [10, 20, 11, 21], 'LINE entity ' + index);
      const a = { x: first(e, 10), y: first(e, 20) }, b = { x: first(e, 11), y: first(e, 21) };
      assertFinite([a.x, a.y, b.x, b.y], 'LINE entity ' + index);
      row.geometry = { type: 'LINE', start: a, end: b };
      quantity = pointDistance(a, b) * metresPerUnit; unit = 'm';
    } else if (e.type === 'LWPOLYLINE') {
      requireCodes(e, [10, 20], 'LWPOLYLINE entity ' + index);
      const vertices = polylineVertices(e), closed = (first(e, 70) & 1) === 1;
      assertFinite(vertices.flatMap(v => [v.x, v.y, v.bulge ?? 0]), 'LWPOLYLINE entity ' + index);
      if (vertices.length < 2) { unsupported[e.type] = (unsupported[e.type] || 0) + 1; continue; }
      const m = polylineMetrics(vertices, closed);
      row.geometry = { type: 'LWPOLYLINE', vertices: vertices.map(v => ({ x: v.x, y: v.y })), closed };
      row.closed = closed;
      row.length_m = m.perimeter * metresPerUnit;
      if (closed) row.area_m2 = m.area * metresPerUnit * metresPerUnit;
      quantity = row.length_m; unit = 'm';
    } else if (e.type === 'CIRCLE') {
      requireCodes(e, [10, 20, 40], 'CIRCLE entity ' + index);
      const center = [first(e, 10), first(e, 20)];
      const radius = first(e, 40);
      assertFinite([...center, radius], 'CIRCLE entity ' + index);
      if (radius < 0) throw new Error('Invalid negative circle radius at entity ' + index);
      row.radius_m = radius * metresPerUnit;
      row.geometry = { type: 'CIRCLE', center: { x: center[0], y: center[1] }, radius };
      row.circumference_m = 2 * Math.PI * row.radius_m;
      row.area_m2 = Math.PI * row.radius_m * row.radius_m;
      quantity = row.circumference_m; unit = 'm';
    } else if (e.type === 'ARC') {
      requireCodes(e, [10, 20, 40, 50, 51], 'ARC entity ' + index);
      const center = [first(e, 10), first(e, 20)];
      const radius = first(e, 40), start = first(e, 50), end = first(e, 51);
      assertFinite([...center, radius, start, end], 'ARC entity ' + index);
      if (radius < 0) throw new Error('Invalid negative arc radius at entity ' + index);
      let sweep = (end - start) % 360;
      if (sweep < 0) sweep += 360;
      row.radius_m = radius * metresPerUnit;
      row.geometry = { type: 'ARC', center: { x: center[0], y: center[1] }, radius, startDegrees: start, sweepDegrees: sweep };
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
    limitations: ['Nested blocks, xrefs and block arrays are not expanded', 'No hatch or spline area extraction', 'No automatic drawing-scale inference', 'No BOQ classification', 'Requires engineer review before contractual use']
  };
}

module.exports = { takeoffDxf, parsePairs, readHeaderUnits, entitiesFrom, normalizeClassicPolylines, blocksFrom, expandBlockInserts, polylineMetrics, UNIT_TO_METRE };
