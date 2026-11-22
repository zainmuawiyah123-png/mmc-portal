'use strict';

const round = (value, places = 4) => Number(value.toFixed(places));
const positive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(name + ' must be a positive finite number');
  return value;
};
const countValue = value => {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('count must be a positive integer');
  return value;
};
const mmToM = value => positive(value, 'dimensionMm') / 1000;

/**
 * Generic, evidence-led measurement kernels.
 * This module deliberately does not detect or classify drawing elements.
 * It only measures elements whose class and source evidence were confirmed upstream.
 */
function measureConfirmedElement(element) {
  if (!element || typeof element !== 'object') throw new TypeError('A measured element is required');
  const id = String(element.id || '').trim();
  if (!id) throw new TypeError('element.id is required');
  const page = element.evidence?.page;
  const evidenceIds = element.evidence?.sourceIds;
  if (!Number.isInteger(page) || page < 1 || !Array.isArray(evidenceIds) || !evidenceIds.length ||
      evidenceIds.some(value => typeof value !== 'string' || !value.trim())) {
    throw new TypeError(id + ': page and sourceIds evidence are required');
  }
  const classification = element.classification;
  if (!classification || typeof classification.label !== 'string' || !classification.label.trim() ||
      classification.status !== 'confirmed' ||
      !['user', 'engineer'].includes(classification.confirmedBy)) {
    throw new TypeError(id + ': element classification must be confirmed by user or engineer');
  }
  const count = countValue(element.count ?? 1);
  const g = element.geometry || {};
  let unit, each, formula, dimensions;

  switch (element.measurement) {
    case 'linear': {
      const length = mmToM(g.lengthMm);
      unit = 'm'; each = length; formula = length + ' m';
      dimensions = { lengthM: round(length) };
      break;
    }
    case 'rectangular_area': {
      const length = mmToM(g.lengthMm), width = mmToM(g.widthMm);
      unit = 'm2'; each = length * width;
      formula = length + ' × ' + width + ' m';
      dimensions = { lengthM: round(length), widthM: round(width) };
      break;
    }
    case 'prismatic_volume': {
      const length = mmToM(g.lengthMm), width = mmToM(g.widthMm), height = mmToM(g.heightMm);
      const gross = length * width * height;
      const deductions = g.deductionsM3 ?? 0;
      if (!Number.isFinite(deductions) || deductions < 0 || deductions >= gross) {
        throw new TypeError(id + ': deductionsM3 must be non-negative and smaller than gross volume');
      }
      unit = 'm3'; each = gross - deductions;
      formula = '(' + length + ' × ' + width + ' × ' + height + ') − ' + deductions + ' m3';
      dimensions = { lengthM: round(length), widthM: round(width), heightM: round(height), grossVolumeM3: round(gross), deductionsM3: round(deductions) };
      break;
    }
    case 'cylindrical_volume': {
      const diameter = mmToM(g.diameterMm), length = mmToM(g.lengthMm);
      const gross = Math.PI * (diameter / 2) ** 2 * length;
      const deductions = g.deductionsM3 ?? 0;
      if (!Number.isFinite(deductions) || deductions < 0 || deductions >= gross) {
        throw new TypeError(id + ': deductionsM3 must be non-negative and smaller than gross volume');
      }
      unit = 'm3'; each = gross - deductions;
      formula = 'π × (' + diameter + ' ÷ 2)² × ' + length + ' − ' + deductions + ' m3';
      dimensions = { diameterM: round(diameter), lengthM: round(length), grossVolumeM3: round(gross), deductionsM3: round(deductions) };
      break;
    }
    case 'count': {
      unit = 'ea'; each = 1; formula = '1 item';
      dimensions = {};
      break;
    }
    default:
      throw new TypeError(id + ': unsupported measurement kernel');
  }

  const total = each * count;
  return {
    id,
    description: String(element.description || classification.label).trim(),
    classification: { label: classification.label.trim(), confirmedBy: classification.confirmedBy },
    measurement: element.measurement,
    unit,
    count,
    dimensions,
    formula: count + ' × (' + formula + ')',
    quantity: round(total),
    evidence: { page, sourceIds: [...new Set(evidenceIds)] },
    status: 'measured_draft_requires_engineering_review',
    approvalEligible: false
  };
}

function buildMeasuredBoq({ documentId, elements } = {}) {
  if (typeof documentId !== 'string' || !documentId.trim()) throw new TypeError('documentId is required');
  if (!Array.isArray(elements) || !elements.length) throw new TypeError('At least one confirmed element is required');
  const ids = new Set();
  const items = elements.map(element => {
    const item = measureConfirmedElement(element);
    if (ids.has(item.id)) throw new TypeError('Duplicate element id: ' + item.id);
    ids.add(item.id);
    return item;
  });
  const totals = {};
  for (const item of items) totals[item.unit] = round((totals[item.unit] || 0) + item.quantity);
  return {
    engine: 'mmc-generic-evidence-measurement-v1',
    documentId: documentId.trim(),
    items,
    totals,
    sourcePages: [...new Set(items.map(item => item.evidence.page))].sort((a, b) => a - b),
    status: 'measured_draft_requires_engineering_review',
    approvalEligible: false,
    limitations: [
      'This kernel measures only elements whose classification and source evidence were explicitly confirmed.',
      'It does not infer drawing scale, classify geometry, count repeated objects or interpret reinforcement schedules.',
      'Deductions must be supplied from separately evidenced openings or voids; no default deductions are applied.',
      'All outputs remain drafts pending engineering review.'
    ]
  };
}

module.exports = { measureConfirmedElement, buildMeasuredBoq };
