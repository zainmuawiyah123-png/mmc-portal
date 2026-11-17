'use strict';

/**
 * MMC AI layer manager.
 * Preserves native CAD layer identity and stores user-created organization as
 * a separate overlay. It never changes source geometry or silently classifies
 * an engineering discipline.
 */
const DISCIPLINES = Object.freeze([
  'general', 'civil_earthworks', 'structural', 'architectural',
  'electrical', 'mechanical_hvac', 'plumbing_drainage',
  'fire_protection', 'specialist'
]);
const MEASUREMENTS = Object.freeze(['length_m', 'area_m2', 'count', 'volume_m3', 'mass_kg']);

function cleanName(value, field = 'layer name') {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(field + ' is required');
  const name = value.trim();
  if (name.length > 128 || /[\r\n\0]/.test(name)) throw new TypeError(field + ' is invalid');
  return name;
}
function keyOf(name) { return cleanName(name).toLocaleLowerCase('en-US'); }
function validateClassification(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('classification must be an object');
  const out = {};
  for (const key of ['discipline', 'system', 'elementType']) {
    if (input[key] !== undefined) out[key] = cleanName(input[key], 'classification.' + key);
  }
  if (out.discipline && !DISCIPLINES.includes(out.discipline)) throw new TypeError('Unsupported discipline');
  if (input.measurements !== undefined) {
    if (!Array.isArray(input.measurements) || input.measurements.some(x => !MEASUREMENTS.includes(x))) {
      throw new TypeError('classification.measurements contains an unsupported measurement');
    }
    out.measurements = [...new Set(input.measurements)];
  }
  if (input.description !== undefined) out.description = cleanName(input.description, 'classification.description');
  return out;
}
function buildLayerCatalog(takeoff, definitions = []) {
  if (!takeoff || !Array.isArray(takeoff.rows)) throw new TypeError('takeoff.rows is required');
  if (!Array.isArray(definitions)) throw new TypeError('layer definitions must be an array');
  const counts = new Map();
  for (const row of takeoff.rows) {
    const name = typeof row?.layer === 'string' && row.layer.trim() ? row.layer.trim() : '0';
    const key = keyOf(name);
    counts.set(key, { name, entityCount: (counts.get(key)?.entityCount || 0) + 1 });
  }
  const definitionMap = new Map();
  for (const definition of definitions) {
    const name = cleanName(definition.name);
    const key = keyOf(name);
    if (definitionMap.has(key)) throw new Error('Duplicate layer definition: ' + name);
    definitionMap.set(key, definition);
  }
  for (const [key, definition] of definitionMap) {
    if (!counts.has(key)) counts.set(key, { name: definition.name, entityCount: 0 });
  }
  return [...counts.entries()].map(([key, item]) => {
    const definition = definitionMap.get(key) || {};
    return {
      id: 'native:' + key,
      name: item.name,
      source: 'native',
      entityCount: item.entityCount,
      visible: definition.visible !== false,
      color: definition.color || null,
      classification: validateClassification(definition.classification || {})
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function createUserLayer(layers, input) {
  if (!Array.isArray(layers)) throw new TypeError('layers must be an array');
  const name = cleanName(input?.name);
  const key = keyOf(name);
  if (layers.some(layer => keyOf(layer.name) === key)) throw new Error('Layer name already exists');
  return [...layers, {
    id: 'user:' + key, name, source: 'user', entityCount: 0,
    visible: input.visible !== false,
    color: input.color || null,
    classification: validateClassification(input.classification || {})
  }];
}
function updateLayer(layers, id, patch) {
  if (!Array.isArray(layers) || !patch || typeof patch !== 'object') throw new TypeError('layers and patch are required');
  const index = layers.findIndex(layer => layer.id === id);
  if (index < 0) throw new Error('Layer not found');
  const current = layers[index];
  if (patch.name !== undefined && keyOf(patch.name) !== keyOf(current.name) &&
      layers.some(layer => layer.id !== id && keyOf(layer.name) === keyOf(patch.name))) {
    throw new Error('Layer name already exists');
  }
  const next = { ...current };
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== 'boolean') throw new TypeError('visible must be boolean');
    next.visible = patch.visible;
  }
  if (patch.color !== undefined) {
    if (patch.color !== null && (typeof patch.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(patch.color))) {
      throw new TypeError('color must be a six-digit hex color or null');
    }
    next.color = patch.color;
  }
  if (patch.classification !== undefined) next.classification = validateClassification(patch.classification);
  const result = layers.slice(); result[index] = next; return result;
}
function deleteUserLayer(layers, id) {
  const target = layers.find(layer => layer.id === id);
  if (!target) throw new Error('Layer not found');
  if (target.source !== 'user') throw new Error('Native CAD layers cannot be deleted from the source catalog');
  return layers.filter(layer => layer.id !== id);
}
function assignEntityLayer(assignments, entityId, targetLayerId) {
  if (!Array.isArray(assignments)) throw new TypeError('assignments must be an array');
  const entity = cleanName(entityId, 'entityId');
  const target = cleanName(targetLayerId, 'targetLayerId');
  const next = assignments.filter(item => item.entityId !== entity);
  next.push({ entityId: entity, targetLayerId: target });
  return next;
}
module.exports = {
  DISCIPLINES, MEASUREMENTS, buildLayerCatalog, createUserLayer,
  updateLayer, deleteUserLayer, assignEntityLayer, validateClassification
};
