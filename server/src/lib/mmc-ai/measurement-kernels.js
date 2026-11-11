'use strict';

/**
 * Deterministic engineering measurement kernels.
 * These functions calculate only from explicit, already-interpreted inputs.
 * They do not read drawings, infer scale, classify soil, route services or
 * decide which elements exist in a project.
 */
const MM_PER_M = 1000;
const ROUNDING_DIGITS = 6;
const round = value => Number(value.toFixed(ROUNDING_DIGITS));
const positive = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(label + ' must be a finite number greater than zero');
};
const nonNegative = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(label + ' must be a finite non-negative number');
};

function calculateEarthworkAverageEndArea(stations) {
  if (!Array.isArray(stations) || stations.length < 2) throw new TypeError('at least two cross-section stations are required');
  const normalized = stations.map((station, index) => {
    if (!station || !Number.isFinite(station.chainageM)) throw new TypeError('station ' + index + ' requires chainageM');
    nonNegative(station.cutAreaM2, 'station cutAreaM2');
    nonNegative(station.fillAreaM2, 'station fillAreaM2');
    return { chainageM: station.chainageM, cutAreaM2: station.cutAreaM2, fillAreaM2: station.fillAreaM2 };
  });
  const intervals = [];
  let cutM3 = 0, fillM3 = 0;
  for (let i = 1; i < normalized.length; i++) {
    const a = normalized[i - 1], b = normalized[i];
    const length = b.chainageM - a.chainageM;
    positive(length, 'station interval length');
    const cut = (a.cutAreaM2 + b.cutAreaM2) / 2 * length;
    const fill = (a.fillAreaM2 + b.fillAreaM2) / 2 * length;
    cutM3 += cut; fillM3 += fill;
    intervals.push({ fromChainageM: a.chainageM, toChainageM: b.chainageM, lengthM: length, cutM3: round(cut), fillM3: round(fill) });
  }
  return {
    method: 'average_end_area',
    ruleId: 'EARTHWORK-AVERAGE-END-AREA',
    ruleVersion: '1.0',
    formula: 'V = ((A1 + A2) / 2) × L; cut and fill calculated separately',
    cutM3: round(cutM3),
    fillM3: round(fillM3),
    intervals,
    inputs: normalized
  };
}

function calculatePrismoidalVolume({ endArea1M2, midAreaM2, endArea2M2, lengthM } = {}) {
  nonNegative(endArea1M2, 'endArea1M2');
  nonNegative(midAreaM2, 'midAreaM2');
  nonNegative(endArea2M2, 'endArea2M2');
  positive(lengthM, 'lengthM');
  const volumeM3 = lengthM / 6 * (endArea1M2 + 4 * midAreaM2 + endArea2M2);
  return {
    method: 'prismoidal',
    ruleId: 'EARTHWORK-PRISMOIDAL',
    ruleVersion: '1.0',
    formula: 'V = L/6 × (A1 + 4Am + A2)',
    volumeM3: round(volumeM3),
    inputs: { endArea1M2, midAreaM2, endArea2M2, lengthM }
  };
}

function calculateRectangularConcrete({ lengthMm, widthMm, depthMm, voidsM3 = [] } = {}) {
  positive(lengthMm, 'lengthMm'); positive(widthMm, 'widthMm'); positive(depthMm, 'depthMm');
  if (!Array.isArray(voidsM3)) throw new TypeError('voidsM3 must be an array of explicitly measured void volumes');
  const gross = lengthMm / MM_PER_M * widthMm / MM_PER_M * depthMm / MM_PER_M;
  let deductions = 0;
  voidsM3.forEach((volume, index) => { nonNegative(volume, 'voidsM3[' + index + ']'); deductions += volume; });
  if (deductions > gross + 1e-9) throw new RangeError('deducted void volume cannot exceed gross concrete volume');
  return {
    method: 'rectangular_prism_with_explicit_void_deductions',
    ruleId: 'CONCRETE-RECTANGULAR-PRISM',
    ruleVersion: '1.0',
    formula: 'Vnet = (L × W × D) in m³ − explicitly measured void volumes',
    grossM3: round(gross),
    voidDeductionsM3: round(deductions),
    netM3: round(gross - deductions),
    inputs: { lengthMm, widthMm, depthMm, voidsM3: [...voidsM3] }
  };
}

function calculateRebarScheduleWeight(bars) {
  if (!Array.isArray(bars) || bars.length === 0) throw new TypeError('at least one bar schedule row is required');
  let totalLengthM = 0, totalWeightKg = 0;
  const rows = bars.map((bar, index) => {
    if (!bar || !Number.isFinite(bar.diameterMm) || !Number.isInteger(bar.count) || bar.count <= 0) {
      throw new TypeError('bar row ' + index + ' requires diameterMm and positive integer count');
    }
    positive(bar.diameterMm, 'bar diameterMm');
    positive(bar.cutLengthMm, 'bar cutLengthMm');
    const lengthM = bar.cutLengthMm / MM_PER_M * bar.count;
    const unitWeightKgPerM = bar.diameterMm * bar.diameterMm / 162;
    const weightKg = lengthM * unitWeightKgPerM;
    totalLengthM += lengthM; totalWeightKg += weightKg;
    return {
      barMark: bar.barMark || null,
      diameterMm: bar.diameterMm,
      count: bar.count,
      cutLengthMm: bar.cutLengthMm,
      totalLengthM: round(lengthM),
      unitWeightKgPerM: round(unitWeightKgPerM),
      weightKg: round(weightKg)
    };
  });
  return {
    method: 'bar_bending_schedule_theoretical_unit_weight',
    ruleId: 'REBAR-DIAMETER-SQUARED-OVER-162',
    ruleVersion: '1.0',
    formula: 'Total weight = Σ(count × cut length in m × diameter²/162 kg/m)',
    totalLengthM: round(totalLengthM),
    totalWeightKg: round(totalWeightKg),
    rows,
    limitations: [
      'Requires a verified bar bending schedule or equivalent reinforcement detailing.',
      'Theoretical unit weight formula is an approximation; project specification or governing standard may prescribe a different basis.',
      'Do not add lap, hook, anchorage or wastage allowances again when they are already included in scheduled cut lengths.'
    ],
    inputs: bars.map(bar => ({ ...bar }))
  };
}


function calculateSlabReinforcementTakeoff({
  slabLengthMm, slabWidthMm, coverMm, barsAlongLength, barsAlongWidth
} = {}) {
  positive(slabLengthMm, 'slabLengthMm');
  positive(slabWidthMm, 'slabWidthMm');
  nonNegative(coverMm, 'coverMm');
  if (coverMm * 2 >= Math.min(slabLengthMm, slabWidthMm)) {
    throw new RangeError('cover must be less than half of both slab dimensions');
  }
  const buildDirection = (config, direction, clearDistributionMm, clearCutLengthMm) => {
    if (!config) return null;
    positive(config.diameterMm, direction + ' diameterMm');
    positive(config.spacingMm, direction + ' spacingMm');
    const layers = config.layers === undefined ? 1 : config.layers;
    if (!Number.isInteger(layers) || layers <= 0) throw new TypeError(direction + ' layers must be a positive integer');
    const distributionCount = Math.ceil(clearDistributionMm / config.spacingMm) + 1;
    const cutLengthMm = clearCutLengthMm;
    const count = distributionCount * layers;
    const totalLengthM = count * cutLengthMm / MM_PER_M;
    const unitWeightKgPerM = config.diameterMm * config.diameterMm / 162;
    return {
      direction, diameterMm: config.diameterMm, spacingMm: config.spacingMm,
      layers, barsPerLayer: distributionCount, totalBars: count,
      cutLengthMm, totalLengthM: round(totalLengthM),
      unitWeightKgPerM: round(unitWeightKgPerM),
      theoreticalWeightKg: round(totalLengthM * unitWeightKgPerM),
      status: 'geometric_estimate_excludes_hooks_laps_chairs_and_opening_trims'
    };
  };
  const clearLength = slabLengthMm - 2 * coverMm;
  const clearWidth = slabWidthMm - 2 * coverMm;
  const rows = [
    buildDirection(barsAlongLength, 'along_length', clearWidth, clearLength),
    buildDirection(barsAlongWidth, 'along_width', clearLength, clearWidth)
  ].filter(Boolean);
  if (!rows.length) throw new TypeError('at least one reinforcement direction is required');
  return {
    method: 'rectangular_slab_uniform_spacing_geometric_estimate',
    ruleId: 'SLAB-REINFORCEMENT-COUNT-LENGTH-WEIGHT',
    ruleVersion: '1.0',
    formula: 'Bars per layer = ceil(clear distribution dimension / spacing) + 1; cut length = slab dimension − 2 × cover; weight = total length × diameter²/162',
    totalBars: rows.reduce((sum, row) => sum + row.totalBars, 0),
    totalLengthM: round(rows.reduce((sum, row) => sum + row.totalLengthM, 0)),
    theoreticalWeightKg: round(rows.reduce((sum, row) => sum + row.theoreticalWeightKg, 0)),
    rows,
    inputs: { slabLengthMm, slabWidthMm, coverMm, barsAlongLength, barsAlongWidth },
    limitations: [
      'Estimate applies only to a rectangular slab with uniform spacing and explicitly supplied directions and layers.',
      'Does not infer top/bottom mats, support bars, additional strips, openings, trimming bars, hooks, bends, anchorage, laps, chairs or wastage.',
      'Confirm edge bar positioning and spacing convention against the approved structural details and project specification before measurement approval.'
    ],
    measurementEligible: false
  };
}

module.exports = {
  calculateEarthworkAverageEndArea,
  calculatePrismoidalVolume,
  calculateRectangularConcrete,
  calculateRebarScheduleWeight,
  calculateSlabReinforcementTakeoff
};
