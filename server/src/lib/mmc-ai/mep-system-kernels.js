'use strict';

/**
 * Discipline-specific MEP measurement kernels.
 * Inputs must be extracted from coordinated plans, risers, schematics,
 * equipment/cable/pipe schedules or approved model data. No fittings,
 * accessories, supports or routing lengths are invented here.
 */
const round = value => Number(value.toFixed(6));
const positive = (v, name) => { if (!Number.isFinite(v) || v <= 0) throw new TypeError(name + ' must be greater than zero'); };
const nonNegative = (v, name) => { if (!Number.isFinite(v) || v < 0) throw new TypeError(name + ' must be non-negative'); };
const integerPositive = (v, name) => { if (!Number.isInteger(v) || v <= 0) throw new TypeError(name + ' must be a positive integer'); };

function calculatePipework(segments, { insulationThicknessMm = 0 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('pipe segments are required');
  nonNegative(insulationThicknessMm, 'insulationThicknessMm');
  let totalLengthM = 0, externalAreaM2 = 0, insulationVolumeM3 = 0;
  const rows = segments.map((s, i) => {
    if (!s) throw new TypeError('pipe segment ' + i + ' is required');
    positive(s.lengthM, 'lengthM');
    positive(s.outsideDiameterMm, 'outsideDiameterMm');
    const runs = s.parallelRuns === undefined ? 1 : s.parallelRuns;
    integerPositive(runs, 'parallelRuns');
    const length = s.lengthM * runs;
    const diameterM = s.outsideDiameterMm / 1000;
    const insulatedDiameterM = diameterM + 2 * insulationThicknessMm / 1000;
    const bareArea = Math.PI * diameterM * length;
    const insulatedArea = Math.PI * insulatedDiameterM * length;
    const insulationVolume = Math.PI / 4 * (insulatedDiameterM ** 2 - diameterM ** 2) * length;
    totalLengthM += length;
    externalAreaM2 += insulationThicknessMm > 0 ? insulatedArea : bareArea;
    insulationVolumeM3 += insulationVolume;
    return {
      segmentId: s.segmentId || null, lengthM: round(s.lengthM), parallelRuns: runs,
      measuredLengthM: round(length), outsideDiameterMm: s.outsideDiameterMm,
      nominalDiameter: s.nominalDiameter || null, material: s.material || null,
      pressureClass: s.pressureClass || null,
      bareExternalAreaM2: round(bareArea),
      insulatedExternalAreaM2: round(insulatedArea),
      insulationVolumeM3: round(insulationVolume)
    };
  });
  return {
    method: 'pipe_centerline_length_and_cylindrical_surface',
    ruleId: 'MEP-PIPE-LENGTH-INSULATION', ruleVersion: '1.0',
    formula: 'Pipe length = Σ(segment length × parallel runs); cylindrical surface = π × outside diameter × length; insulation volume = π/4 × (Dins² − Dpipe²) × length',
    totalLengthM: round(totalLengthM), externalAreaM2: round(externalAreaM2),
    insulationVolumeM3: round(insulationVolumeM3), insulationThicknessMm,
    rows,
    limitations: [
      'Use actual outside diameter, not DN, for surface and insulation calculations.',
      'Bends, tees, reducers, flanges, valves, joints, supports, sleeves and testing are separate schedule/detail items.',
      'Do not add insulation area as a pipe length quantity; keep each unit and BOQ item separate.'
    ]
  };
}

function calculateCableSchedule(runs) {
  if (!Array.isArray(runs) || runs.length === 0) throw new TypeError('cable schedule rows are required');
  let totalCableLengthM = 0, totalConductorLengthM = 0;
  const rows = runs.map((r, i) => {
    if (!r) throw new TypeError('cable row ' + i + ' is required');
    positive(r.routeLengthM, 'routeLengthM');
    const parallelRuns = r.parallelRuns === undefined ? 1 : r.parallelRuns;
    const cores = r.cores === undefined ? 1 : r.cores;
    integerPositive(parallelRuns, 'parallelRuns');
    integerPositive(cores, 'cores');
    const cableLength = r.routeLengthM * parallelRuns;
    const conductorLength = cableLength * cores;
    totalCableLengthM += cableLength;
    totalConductorLengthM += conductorLength;
    return {
      cableTag: r.cableTag || null, cableType: r.cableType || null,
      sizeMm2: r.sizeMm2 || null, routeLengthM: r.routeLengthM,
      parallelRuns, cores, cableLengthM: round(cableLength),
      conductorLengthM: round(conductorLength),
      from: r.from || null, to: r.to || null, circuit: r.circuit || null
    };
  });
  return {
    method: 'cable_schedule_route_length',
    ruleId: 'ELECTRICAL-CABLE-LENGTH-AND-CORE-LENGTH', ruleVersion: '1.0',
    formula: 'Cable length = Σ(route length × parallel runs); conductor length = cable length × number of cores',
    totalCableLengthM: round(totalCableLengthM),
    totalConductorLengthM: round(totalConductorLengthM), rows,
    limitations: [
      'BOQ cable length is not the same as aggregate conductor length; report them separately.',
      'Terminations, glands, lugs, joints, tray/conduit, supports and approved slack are separate or explicitly specified items.',
      'Cable routes must be traced from coordinated layouts and risers; schematic topology alone may not establish installed route length.'
    ]
  };
}

function calculateCableTray(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('cable tray segments are required');
  let totalLengthM = 0, coverAreaM2 = 0;
  const rows = segments.map((s, i) => {
    if (!s) throw new TypeError('tray segment ' + i + ' is required');
    positive(s.lengthM, 'lengthM');
    positive(s.widthMm, 'widthMm');
    const runs = s.parallelRuns === undefined ? 1 : s.parallelRuns;
    integerPositive(runs, 'parallelRuns');
    const length = s.lengthM * runs;
    totalLengthM += length;
    coverAreaM2 += (s.widthMm / 1000) * length;
    return { segmentId: s.segmentId || null, lengthM: s.lengthM, widthMm: s.widthMm, parallelRuns: runs, measuredLengthM: round(length), planCoverAreaM2: round((s.widthMm / 1000) * length), material: s.material || null };
  });
  return {
    method: 'cable_tray_route_length_and_plan_cover',
    ruleId: 'ELECTRICAL-CABLE-TRAY', ruleVersion: '1.0',
    formula: 'Tray length = Σ(segment length × parallel runs); plan cover area = tray width × measured length',
    totalLengthM: round(totalLengthM), planCoverAreaM2: round(coverAreaM2), rows,
    limitations: ['Plan cover area is not sheet-metal fabrication area.', 'Bends, tees, reducers, covers, couplers, supports and earthing bonds require details or schedules.']
  };
}

module.exports = { calculatePipework, calculateCableSchedule, calculateCableTray };
