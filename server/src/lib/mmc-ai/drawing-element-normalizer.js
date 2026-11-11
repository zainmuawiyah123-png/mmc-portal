'use strict';

/**
 * MMC AI drawing-source normalization.
 * Converts measured DXF primitives into traceable engineering candidates.
 * It does NOT infer engineering meaning from layer names or claim a complete
 * drawing interpretation. Every layer classification must be explicitly
 * supplied and every output remains review-required.
 */
const crypto = require('node:crypto');

const MEASUREMENTS = Object.freeze([
  ['length_m', 'm'],
  ['area_m2', 'm2']
]);

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(field + ' is required');
  return value.trim();
}

function normalizeDxfDrawing({ content, takeoff, document, layerMap = {} }) {
  if (typeof content !== 'string' || !content.trim()) throw new TypeError('DXF content is required');
  if (!takeoff || !Array.isArray(takeoff.rows)) throw new TypeError('DXF takeoff rows are required');
  if (!document || typeof document !== 'object') throw new TypeError('Document metadata is required');
  const documentId = requiredText(document.documentId, 'document.documentId');
  const revision = requiredText(document.revision, 'document.revision');
  const sheetOrPage = requiredText(document.sheetOrPage, 'document.sheetOrPage');
  if (!layerMap || typeof layerMap !== 'object' || Array.isArray(layerMap)) throw new TypeError('layerMap must be an object');

  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const seen = new Set();
  const elements = [];
  const unresolved = [];

  for (const row of takeoff.rows) {
    if (!row || !Number.isInteger(row.entityIndex) || row.entityIndex < 0) {
      throw new TypeError('Every DXF measurement must have a non-negative entityIndex');
    }
    const sourceEntityId = [documentId, revision, sheetOrPage, row.entityIndex].join(':');
    if (seen.has(sourceEntityId)) throw new Error('Duplicate source entity detected: ' + sourceEntityId);
    seen.add(sourceEntityId);

    const source = {
      documentId, documentSha256: sha256, revision, sheetOrPage,
      sourceEntityId, sourceEntityIndex: row.entityIndex,
      entityType: requiredText(String(row.entity || ''), 'row.entity'),
      layer: typeof row.layer === 'string' && row.layer.trim() ? row.layer.trim() : '0',
      sourceBlock: row.sourceBlock || null,
      units: takeoff.units || null,
      engine: takeoff.engine || 'unknown'
    };
    const classification = layerMap[source.layer];

    if (!classification || !['discipline', 'system', 'elementType'].every(key =>
      typeof classification[key] === 'string' && classification[key].trim())) {
      unresolved.push({ source, reason: 'layer_classification_missing_or_incomplete' });
      continue;
    }

    const measurements = [];
    for (const [field, unit] of MEASUREMENTS) {
      const permitted = Array.isArray(classification.measurements) && classification.measurements.includes(field);
      if (permitted && Number.isFinite(row[field]) && row[field] > 0) {
        measurements.push({ measurement: field, quantity: Number(row[field].toFixed(6)), unit });
      }
    }
    if (Number.isFinite(row.quantity) && row.quantity > 0 && typeof row.unit === 'string') {
      const field = row.unit === 'm' ? 'length_m' : row.unit === 'm2' ? 'area_m2' : null;
      const permitted = field && Array.isArray(classification.measurements) && classification.measurements.includes(field);
      if (permitted && !measurements.some(item => item.measurement === field)) {
        measurements.push({ measurement: field, quantity: Number(row.quantity.toFixed(6)), unit: row.unit });
      }
    }

    if (!measurements.length) {
      unresolved.push({ source, reason: 'no_supported_measurement_permitted_for_classification' });
      continue;
    }

    elements.push({
      id: 'SRC-' + String(elements.length + 1).padStart(6, '0'),
      discipline: classification.discipline.trim(),
      system: classification.system.trim(),
      elementType: classification.elementType.trim(),
      description: classification.description || classification.elementType.trim(),
      specification: classification.specification || null,
      measurements,
      source,
      reviewState: 'requires_engineering_review',
      approvalEligible: false
    });
  }

  return {
    status: unresolved.length ? 'ingested_with_unresolved_elements' : 'ingested_requires_engineering_review',
    sourceFormat: 'DXF',
    sourceDocument: { documentId, revision, sheetOrPage, sha256, entityCount: takeoff.rows.length },
    elementCount: elements.length,
    unresolvedCount: unresolved.length,
    elements,
    unresolved,
    limitations: [
      'Engineering classifications require an explicit reviewed layer map.',
      'DXF geometry alone cannot establish material, reinforcement, depth, specification or BOQ applicability.',
      'No quantity is promoted to approved or contractual status by this adapter.',
      'Unsupported DXF entities remain outside this normalized result and must be reported by the DXF parser.'
    ]
  };
}

module.exports = { normalizeDxfDrawing };
