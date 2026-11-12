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


function calculateIsolatedFootingTakeoff({
  lengthMm, widthMm, thicknessMm, coverMm,
  reinforcementAlongLength, reinforcementAlongWidth, pedestal, voidsM3 = []
} = {}) {
  positive(lengthMm, 'footing lengthMm');
  positive(widthMm, 'footing widthMm');
  positive(thicknessMm, 'footing thicknessMm');
  const concrete = calculateRectangularConcrete({
    lengthMm, widthMm, depthMm: thicknessMm, voidsM3
  });
  let pedestalResult = null;
  if (pedestal) {
    positive(pedestal.lengthMm, 'pedestal lengthMm');
    positive(pedestal.widthMm, 'pedestal widthMm');
    positive(pedestal.heightMm, 'pedestal heightMm');
    if (pedestal.lengthMm > lengthMm || pedestal.widthMm > widthMm) {
      throw new RangeError('pedestal plan dimensions cannot exceed footing dimensions');
    }
    pedestalResult = {
      lengthMm: pedestal.lengthMm,
      widthMm: pedestal.widthMm,
      heightMm: pedestal.heightMm,
      concreteM3: round(pedestal.lengthMm / MM_PER_M * pedestal.widthMm / MM_PER_M * pedestal.heightMm / MM_PER_M)
    };
  }
  let reinforcement = null;
  if (reinforcementAlongLength || reinforcementAlongWidth) {
    reinforcement = calculateSlabReinforcementTakeoff({
      slabLengthMm: lengthMm, slabWidthMm: widthMm, coverMm,
      barsAlongLength: reinforcementAlongLength,
      barsAlongWidth: reinforcementAlongWidth
    });
  }
  return {
    method: 'isolated_rectangular_footing_explicit_geometry',
    ruleId: 'FOOTING-CONCRETE-AND-BASE-MAT-REINFORCEMENT',
    ruleVersion: '1.0',
    footingConcreteM3: concrete.netM3,
    footingGrossConcreteM3: concrete.grossM3,
    voidDeductionsM3: concrete.voidDeductionsM3,
    pedestal,
    pedestalConcreteM3: pedestalResult ? pedestalResult.concreteM3 : null,
    combinedConcreteM3: round(concrete.netM3 + (pedestalResult ? pedestalResult.concreteM3 : 0)),
    reinforcement,
    inputs: { lengthMm, widthMm, thicknessMm, coverMm, reinforcementAlongLength, reinforcementAlongWidth, pedestal, voidsM3: [...voidsM3] },
    limitations: [
      'Only explicitly dimensioned rectangular footing and optional rectangular pedestal volumes are included.',
      'Reinforcement estimate covers only the explicitly supplied uniform base-mat directions and layers.',
      'Column starters, dowels, top bars, hooks, bends, anchorage, laps, chairs, blinding concrete, side slopes and wastage are excluded unless separately measured.',
      'Do not use until footing geometry, cover, bar layout and measurement convention are checked against approved drawings and specifications.'
    ],
    measurementEligible: false
  };
}


function calculateColumnTakeoff({
  heightMm, sectionWidthMm, sectionDepthMm, longitudinalBars,
  ties, coverMm, spliceLengthMm = 0
} = {}) {
  positive(heightMm, 'heightMm');
  positive(sectionWidthMm, 'sectionWidthMm');
  positive(sectionDepthMm, 'sectionDepthMm');
  nonNegative(coverMm, 'coverMm');
  nonNegative(spliceLengthMm, 'spliceLengthMm');
  if (coverMm * 2 >= Math.min(sectionWidthMm, sectionDepthMm)) {
    throw new RangeError('cover must be less than half of both column section dimensions');
  }
  if (!Array.isArray(longitudinalBars) || longitudinalBars.length === 0) {
    throw new TypeError('longitudinalBars schedule is required');
  }
  const grossConcreteM3 = heightMm / MM_PER_M * sectionWidthMm / MM_PER_M * sectionDepthMm / MM_PER_M;
  const formworkM2 = 2 * (sectionWidthMm + sectionDepthMm) / MM_PER_M * heightMm / MM_PER_M;
  const longitudinal = calculateRebarScheduleWeight(longitudinalBars.map((bar, index) => ({
    ...bar,
    cutLengthMm: bar.cutLengthMm === undefined ? heightMm + spliceLengthMm : bar.cutLengthMm
  })));
  let tieResult = null;
  if (ties) {
    positive(ties.diameterMm, 'ties diameterMm');
    positive(ties.spacingMm, 'ties spacingMm');
    const tieCount = Math.ceil(heightMm / ties.spacingMm) + 1;
    const tieWidthMm = sectionWidthMm - 2 * coverMm;
    const tieDepthMm = sectionDepthMm - 2 * coverMm;
    const tieShape = ties.cutLengthMm === undefined ? null : ties.cutLengthMm;
    const tieLengthMm = tieShape === null ? null : tieShape;
    tieResult = {
      diameterMm: ties.diameterMm,
      spacingMm: ties.spacingMm,
      count: tieCount,
      cutLengthMm: tieLengthMm,
      totalLengthM: tieLengthMm === null ? null : round(tieCount * tieLengthMm / MM_PER_M),
      theoreticalWeightKg: tieLengthMm === null ? null : round(tieCount * tieLengthMm / MM_PER_M * ties.diameterMm * ties.diameterMm / 162),
      internalCoreWidthMm: tieWidthMm,
      internalCoreDepthMm: tieDepthMm,
      status: tieLengthMm === null ? 'tie_count_candidate_cut_length_requires_hook_and_bend_detail' : 'explicit_tie_cut_length_estimate'
    };
  }
  return {
    method: 'rectangular_column_explicit_schedule_estimate',
    ruleId: 'COLUMN-CONCRETE-FORMWORK-LONGITUDINAL-REBAR-TIES',
    ruleVersion: '1.0',
    formula: 'Concrete = width × depth × height; formwork = perimeter × height; bar weight = Σ(count × cut length × diameter²/162)',
    concreteM3: round(grossConcreteM3),
    formworkM2: round(formworkM2),
    longitudinalReinforcement: longitudinal,
    ties: tieResult,
    totalSteelWeightKg: round(longitudinal.totalWeightKg + (tieResult?.theoreticalWeightKg || 0)),
    inputs: { heightMm, sectionWidthMm, sectionDepthMm, longitudinalBars, ties, coverMm, spliceLengthMm },
    limitations: [
      'Rectangular prismatic column only; beams, capitals, offsets and non-prismatic zones are excluded.',
      'Longitudinal bar cut lengths default to clear storey height plus the explicitly supplied splice length; anchorage into footing, beam or slab is excluded.',
      'Tie count is a uniform-spacing estimate; confinement zones, end-zone spacing changes and seismic detailing must be supplied and checked separately.',
      'Tie weight is omitted unless an explicit cut length including hooks and bends is supplied.',
      'Formwork excludes construction joints, deductions and special surface conditions.',
      'Verify lap locations, development lengths, cover, seismic detailing and measurement rules against approved structural drawings and specifications.'
    ],
    measurementEligible: false
  };
}

function calculateBeamTakeoff({
  lengthMm, widthMm, overallDepthMm, slabThicknessMm = 0,
  longitudinalBars, stirrups, coverMm
} = {}) {
  positive(lengthMm, 'lengthMm');
  positive(widthMm, 'widthMm');
  positive(overallDepthMm, 'overallDepthMm');
  nonNegative(slabThicknessMm, 'slabThicknessMm');
  nonNegative(coverMm, 'coverMm');
  if (slabThicknessMm >= overallDepthMm) throw new RangeError('slabThicknessMm must be less than overallDepthMm');
  if (coverMm * 2 >= Math.min(widthMm, overallDepthMm)) throw new RangeError('cover must be less than half of beam width and depth');
  if (!Array.isArray(longitudinalBars) || longitudinalBars.length === 0) throw new TypeError('longitudinalBars schedule is required');
  const beamConcreteM3 = lengthMm / MM_PER_M * widthMm / MM_PER_M * (overallDepthMm - slabThicknessMm) / MM_PER_M;
  const formworkM2 = lengthMm / MM_PER_M * (widthMm + 2 * (overallDepthMm - slabThicknessMm)) / MM_PER_M;
  const longitudinal = calculateRebarScheduleWeight(longitudinalBars);
  let stirrupResult = null;
  if (stirrups) {
    positive(stirrups.diameterMm, 'stirrups diameterMm');
    positive(stirrups.spacingMm, 'stirrups spacingMm');
    const count = Math.ceil(lengthMm / stirrups.spacingMm) + 1;
    stirrupResult = {
      diameterMm: stirrups.diameterMm,
      spacingMm: stirrups.spacingMm,
      count,
      cutLengthMm: stirrups.cutLengthMm === undefined ? null : stirrups.cutLengthMm,
      totalLengthM: stirrups.cutLengthMm === undefined ? null : round(count * stirrups.cutLengthMm / MM_PER_M),
      theoreticalWeightKg: stirrups.cutLengthMm === undefined ? null : round(count * stirrups.cutLengthMm / MM_PER_M * stirrups.diameterMm * stirrups.diameterMm / 162),
      status: stirrups.cutLengthMm === undefined ? 'stirrup_count_candidate_requires_zone_spacing_and_bend_detail' : 'explicit_stirrup_cut_length_estimate'
    };
  }
  return {
    method: 'rectangular_beam_explicit_schedule_estimate',
    ruleId: 'BEAM-CONCRETE-FORMWORK-LONGITUDINAL-REBAR-STIRRUPS',
    ruleVersion: '1.0',
    formula: 'Concrete = length × width × (overall depth − slab thickness); formwork = length × (width + 2 × effective depth); reinforcement from explicit bar schedule',
    concreteM3: round(beamConcreteM3),
    formworkM2: round(formworkM2),
    longitudinalReinforcement: longitudinal,
    stirrups: stirrupResult,
    totalSteelWeightKg: round(longitudinal.totalWeightKg + (stirrupResult?.theoreticalWeightKg || 0)),
    inputs: { lengthMm, widthMm, overallDepthMm, slabThicknessMm, longitudinalBars, stirrups, coverMm },
    limitations: [
      'Rectangular prismatic beam only; haunches, drops, tapered sections and complex beam-column joints are excluded.',
      'Concrete volume subtracts the explicitly supplied slab thickness only; intersection deductions and pour-sequence rules require project measurement policy.',
      'Uniform stirrup count is indicative only; support zones, midspan zones and seismic confinement spacing must be measured separately.',
      'Stirrup weight is omitted unless explicit cut length including hooks and bends is supplied.',
      'Verify bar curtailment, anchorage, laps, support zones, cover and applicable measurement rules against approved details.'
    ],
    measurementEligible: false
  };
}


function calculateConcreteWallTakeoff({
  lengthMm, heightMm, thicknessMm, coverMm,
  verticalBars, horizontalBars, openings = []
} = {}) {
  positive(lengthMm, 'lengthMm');
  positive(heightMm, 'heightMm');
  positive(thicknessMm, 'thicknessMm');
  nonNegative(coverMm, 'coverMm');
  if (coverMm * 2 >= Math.min(lengthMm, heightMm, thicknessMm)) {
    throw new RangeError('cover must be less than half of wall dimensions');
  }
  if (!Array.isArray(openings)) throw new TypeError('openings must be an array');
  let openingAreaM2 = 0;
  const normalizedOpenings = openings.map((opening, index) => {
    positive(opening.widthMm, 'openings[' + index + '].widthMm');
    positive(opening.heightMm, 'openings[' + index + '].heightMm');
    const area = opening.widthMm / MM_PER_M * opening.heightMm / MM_PER_M;
    openingAreaM2 += area;
    return { mark: opening.mark || null, widthMm: opening.widthMm, heightMm: opening.heightMm, areaM2: round(area) };
  });
  const grossFaceAreaM2 = lengthMm / MM_PER_M * heightMm / MM_PER_M;
  if (openingAreaM2 > grossFaceAreaM2 + 1e-9) {
    throw new RangeError('opening areas cannot exceed gross wall face area');
  }
  const voidVolumesM3 = normalizedOpenings.map(opening => opening.areaM2 * thicknessMm / MM_PER_M);
  const concrete = calculateRectangularConcrete({
    lengthMm, widthMm: thicknessMm, depthMm: heightMm, voidsM3: voidVolumesM3
  });
  const reinforcement = (verticalBars || horizontalBars) ? calculateSlabReinforcementTakeoff({
    slabLengthMm: lengthMm,
    slabWidthMm: heightMm,
    coverMm,
    barsAlongLength: horizontalBars ? { ...horizontalBars, layers: (horizontalBars.layers || 1) * 2 } : null,
    barsAlongWidth: verticalBars ? { ...verticalBars, layers: (verticalBars.layers || 1) * 2 } : null
  }) : null;
  return {
    method: 'rectangular_concrete_wall_with_explicit_opening_deductions',
    ruleId: 'WALL-CONCRETE-FORMWORK-DOUBLE_FACE-REINFORCEMENT',
    ruleVersion: '1.0',
    formula: 'Net concrete = length × height × thickness − explicit opening volumes; double-face formwork = 2 × (gross face area − opening area)',
    grossConcreteM3: concrete.grossM3,
    openingDeductionsM3: concrete.voidDeductionsM3,
    netConcreteM3: concrete.netM3,
    grossFormworkBothFacesM2: round(grossFaceAreaM2 * 2),
    netFormworkBothFacesM2: round((grossFaceAreaM2 - openingAreaM2) * 2),
    openingAreaM2: round(openingAreaM2),
    openings: normalizedOpenings,
    reinforcement,
    inputs: { lengthMm, heightMm, thicknessMm, coverMm, verticalBars, horizontalBars, openings },
    limitations: [
      'Rectangular constant-thickness wall only; returns gross double-face formwork less explicitly dimensioned opening faces.',
      'Opening reveal formwork, lintels, jambs, sills, boundary elements and local thickening are excluded.',
      'Reinforcement estimate assumes two identical faces and uniform spacing; opening trimming bars, extra bars, boundary reinforcement and anchorage are excluded.',
      'Opening locations are not used to trim individual bars; reinforcement result is a gross theoretical estimate and must not be treated as an approved net bar schedule.',
      'Verify construction joints, pour sequence, cover, lap and development lengths, wall boundary zones and project measurement rules.'
    ],
    measurementEligible: false
  };
}


function calculateConcreteStairTakeoff({
  clearWidthMm, goingMm, riserMm, stepCount, waistThicknessMm,
  landingLengthMm = 0, landingThicknessMm = waistThicknessMm
} = {}) {
  positive(clearWidthMm, 'clearWidthMm');
  positive(goingMm, 'goingMm');
  positive(riserMm, 'riserMm');
  positive(waistThicknessMm, 'waistThicknessMm');
  if (!Number.isInteger(stepCount) || stepCount <= 0) throw new TypeError('stepCount must be a positive integer');
  nonNegative(landingLengthMm, 'landingLengthMm');
  positive(landingThicknessMm, 'landingThicknessMm');
  const totalRunMm = goingMm * stepCount;
  const totalRiseMm = riserMm * stepCount;
  const inclinedLengthMm = Math.sqrt(totalRunMm ** 2 + totalRiseMm ** 2);
  const waistVolumeM3 = clearWidthMm / MM_PER_M * inclinedLengthMm / MM_PER_M * waistThicknessMm / MM_PER_M;
  const stepVolumeM3 = clearWidthMm / MM_PER_M * (goingMm / MM_PER_M) * (riserMm / MM_PER_M) * stepCount / 2;
  const landingVolumeM3 = landingLengthMm > 0
    ? clearWidthMm / MM_PER_M * landingLengthMm / MM_PER_M * landingThicknessMm / MM_PER_M : 0;
  const soffitAreaM2 = clearWidthMm / MM_PER_M * inclinedLengthMm / MM_PER_M;
  const sideProfileAreaM2 = 2 * (
    (totalRunMm / MM_PER_M) * (totalRiseMm / MM_PER_M) / 2 +
    (totalRunMm / MM_PER_M) * (waistThicknessMm / MM_PER_M)
  );
  return {
    method: 'straight_flight_stair_waist_plus_triangular_step_prisms',
    ruleId: 'STAIR-CONCRETE-GEOMETRY',
    ruleVersion: '1.0',
    formula: 'Concrete = waist width × inclined length × waist thickness + step count × width × going × riser / 2 + landing volume',
    totalRunMm, totalRiseMm, inclinedLengthMm: round(inclinedLengthMm),
    waistConcreteM3: round(waistVolumeM3),
    stepConcreteM3: round(stepVolumeM3),
    landingConcreteM3: round(landingVolumeM3),
    totalConcreteM3: round(waistVolumeM3 + stepVolumeM3 + landingVolumeM3),
    soffitFormworkM2: round(soffitAreaM2),
    sideProfileFormworkM2: round(sideProfileAreaM2),
    inputs: { clearWidthMm, goingMm, riserMm, stepCount, waistThicknessMm, landingLengthMm, landingThicknessMm },
    limitations: [
      'Straight single flight only; winders, spiral stairs, folded plates, beams, support ribs and complex landings are excluded.',
      'Step concrete assumes triangular wedge volume per step above the waist slab; confirm the project measurement convention to avoid overlap or double counting.',
      'Landing geometry is represented as a separate rectangular slab; landing supports and beams are excluded.',
      'Reinforcement, nosing details, finishes, handrails, edge beams and construction joints are not included.',
      'Verify dimensions and structural section against approved drawings before measurement approval.'
    ],
    measurementEligible: false
  };
}

function calculateRetainingWallTakeoff({
  stemLengthMm, stemHeightMm, stemThicknessMm,
  baseWidthMm, baseThicknessMm, heelWidthMm = 0, toeWidthMm = 0,
  footingLengthMm = stemLengthMm
} = {}) {
  positive(stemLengthMm, 'stemLengthMm');
  positive(stemHeightMm, 'stemHeightMm');
  positive(stemThicknessMm, 'stemThicknessMm');
  positive(baseWidthMm, 'baseWidthMm');
  positive(baseThicknessMm, 'baseThicknessMm');
  positive(footingLengthMm, 'footingLengthMm');
  nonNegative(heelWidthMm, 'heelWidthMm');
  nonNegative(toeWidthMm, 'toeWidthMm');
  if (heelWidthMm + toeWidthMm + stemThicknessMm > baseWidthMm + 1e-9) {
    throw new RangeError('heel, toe and stem thickness cannot exceed base width');
  }
  if (stemThicknessMm > baseWidthMm) throw new RangeError('stem thickness cannot exceed base width');
  const stemConcreteM3 = stemLengthMm / MM_PER_M * stemHeightMm / MM_PER_M * stemThicknessMm / MM_PER_M;
  const baseConcreteM3 = footingLengthMm / MM_PER_M * baseWidthMm / MM_PER_M * baseThicknessMm / MM_PER_M;
  const stemFacesM2 = 2 * stemLengthMm / MM_PER_M * stemHeightMm / MM_PER_M;
  const stemEndsM2 = 2 * stemHeightMm / MM_PER_M * stemThicknessMm / MM_PER_M;
  const baseEdgesM2 = 2 * (footingLengthMm + baseWidthMm) / MM_PER_M * baseThicknessMm / MM_PER_M;
  return {
    method: 'rectangular_retaining_wall_stem_and_base',
    ruleId: 'RETAINING-WALL-CONCRETE-FORMWORK',
    ruleVersion: '1.0',
    formula: 'Concrete = stem length × stem height × stem thickness + footing length × base width × base thickness',
    stemConcreteM3: round(stemConcreteM3),
    baseConcreteM3: round(baseConcreteM3),
    totalConcreteM3: round(stemConcreteM3 + baseConcreteM3),
    stemFaceFormworkM2: round(stemFacesM2),
    stemEndFormworkM2: round(stemEndsM2),
    baseEdgeFormworkM2: round(baseEdgesM2),
    totalFormworkM2: round(stemFacesM2 + stemEndsM2 + baseEdgesM2),
    inputs: { stemLengthMm, stemHeightMm, stemThicknessMm, baseWidthMm, baseThicknessMm, heelWidthMm, toeWidthMm, footingLengthMm },
    limitations: [
      'Rectangular stem and rectangular base only; battered stems, shear keys, counterforts, drainage layers and stepped bases are excluded.',
      'Heel and toe dimensions are recorded for validation but no tapered or sloped geometry is inferred.',
      'Formwork is a gross exposed-face estimate; soil-contact and blinding-contact faces must be deducted according to project measurement rules.',
      'Reinforcement, waterstops, weep holes, drainage pipes, filters, waterproofing, backfill and excavation are excluded.',
      'Verify stability design geometry, construction joints, cover and approved reinforcement details before measurement approval.'
    ],
    measurementEligible: false
  };
}

module.exports = {
  calculateEarthworkAverageEndArea,
  calculatePrismoidalVolume,
  calculateRectangularConcrete,
  calculateRebarScheduleWeight,
  calculateSlabReinforcementTakeoff,
  calculateIsolatedFootingTakeoff,
  calculateColumnTakeoff,
  calculateBeamTakeoff,
  calculateConcreteWallTakeoff,
  calculateConcreteStairTakeoff,
  calculateRetainingWallTakeoff
};
