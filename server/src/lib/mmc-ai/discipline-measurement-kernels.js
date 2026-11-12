'use strict';

/**
 * Further deterministic measurement kernels for architectural and MEP work.
 * Inputs must already be interpreted and classified from approved project
 * evidence. Fittings, bends, supports and accessories require schedules or
 * explicit geometry; these functions never invent them.
 */
const round = value => Number(value.toFixed(6));
const positive = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(label + ' must be a finite number greater than zero');
};
const nonNegative = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(label + ' must be a finite non-negative number');
};

function calculateMasonryWall({ walls } = {}) {
  if (!Array.isArray(walls) || walls.length === 0) throw new TypeError('at least one classified wall is required');
  let grossAreaM2 = 0, openingsAreaM2 = 0, netAreaM2 = 0, netVolumeM3 = 0;
  const rows = walls.map((wall, index) => {
    if (!wall) throw new TypeError('wall ' + index + ' is required');
    positive(wall.lengthM, 'wall lengthM');
    positive(wall.heightM, 'wall heightM');
    positive(wall.thicknessMm, 'wall thicknessMm');
    const gross = wall.lengthM * wall.heightM;
    const openings = Array.isArray(wall.openings) ? wall.openings : [];
    const openingArea = openings.reduce((sum, opening, openingIndex) => {
      if (!opening) throw new TypeError('opening ' + openingIndex + ' is required');
      positive(opening.widthM, 'opening widthM');
      positive(opening.heightM, 'opening heightM');
      return sum + opening.widthM * opening.heightM;
    }, 0);
    if (openingArea > gross + 1e-9) throw new RangeError('opening area cannot exceed wall gross area');
    const net = gross - openingArea;
    const volume = net * wall.thicknessMm / 1000;
    grossAreaM2 += gross; openingsAreaM2 += openingArea; netAreaM2 += net; netVolumeM3 += volume;
    return { wallId: wall.wallId || null, grossAreaM2: round(gross), openingDeductionsM2: round(openingArea), netAreaM2: round(net), thicknessMm: wall.thicknessMm, netVolumeM3: round(volume), openingCount: openings.length };
  });
  return {
    method: 'classified_wall_area_with_opening_deductions',
    ruleId: 'MASONRY-NET-WALL-AREA-VOLUME',
    ruleVersion: '1.0',
    formula: 'Net wall area = Σ(length × height − measured openings); volume = net area × thickness',
    grossAreaM2: round(grossAreaM2),
    openingDeductionsM2: round(openingsAreaM2),
    netAreaM2: round(netAreaM2),
    netVolumeM3: round(netVolumeM3),
    rows,
    limitations: ['Opening deduction policy and minimum deduction thresholds must follow the contract measurement standard.', 'Lintels, jambs, sills, reinforcement and wall ties are separate measured items.']
  };
}

function calculateRectangularDuctwork(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('duct segments are required');
  let totalLengthM = 0, totalSurfaceAreaM2 = 0;
  const rows = segments.map((segment, index) => {
    if (!segment) throw new TypeError('duct segment ' + index + ' is required');
    positive(segment.lengthM, 'duct lengthM');
    positive(segment.widthMm, 'duct widthMm');
    positive(segment.heightMm, 'duct heightMm');
    const widthM = segment.widthMm / 1000, heightM = segment.heightMm / 1000;
    const perimeterM = 2 * (widthM + heightM);
    const areaM2 = perimeterM * segment.lengthM;
    totalLengthM += segment.lengthM; totalSurfaceAreaM2 += areaM2;
    return { segmentId: segment.segmentId || null, lengthM: round(segment.lengthM), widthMm: segment.widthMm, heightMm: segment.heightMm, externalSurfaceAreaM2: round(areaM2), material: segment.material || null, pressureClass: segment.pressureClass || null };
  });
  return {
    method: 'straight_rectangular_duct_external_surface',
    ruleId: 'HVAC-RECTANGULAR-DUCT-SURFACE',
    ruleVersion: '1.0',
    formula: 'External surface area = Σ[2 × (width + height) × straight length], dimensions converted to metres',
    totalLengthM: round(totalLengthM),
    externalSurfaceAreaM2: round(totalSurfaceAreaM2),
    rows,
    limitations: ['Fittings, transitions, elbows, branches, dampers, flanges, stiffeners, supports and insulation are not inferred; measure from coordinated details or schedules.', 'This is external surface area for straight rectangular duct segments, not a complete duct fabrication takeoff.']
  };
}

function calculateRoutedServices(segments, { serviceType, explicitAllowancePercent = 0 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('routed service segments are required');
  if (!['pipe', 'cable', 'conduit'].includes(serviceType)) throw new TypeError('serviceType must be pipe, cable or conduit');
  nonNegative(explicitAllowancePercent, 'explicitAllowancePercent');
  if (explicitAllowancePercent > 100) throw new RangeError('explicit allowance cannot exceed 100 percent');
  let baseLengthM = 0;
  const rows = segments.map((segment, index) => {
    if (!segment) throw new TypeError('segment ' + index + ' is required');
    positive(segment.lengthM, 'segment lengthM');
    const parallelRuns = segment.parallelRuns === undefined ? 1 : segment.parallelRuns;
    if (!Number.isInteger(parallelRuns) || parallelRuns <= 0) throw new TypeError('parallelRuns must be a positive integer');
    const measured = segment.lengthM * parallelRuns;
    baseLengthM += measured;
    return { routeId: segment.routeId || null, segmentLengthM: segment.lengthM, parallelRuns, measuredLengthM: round(measured), size: segment.size || null, material: segment.material || null, circuitOrSystem: segment.circuitOrSystem || null };
  });
  const allowanceM = baseLengthM * explicitAllowancePercent / 100;
  return {
    method: 'measured_route_segments_with_explicit_allowance',
    ruleId: serviceType.toUpperCase() + '-ROUTE-LENGTH',
    ruleVersion: '1.0',
    formula: 'Measured length = Σ(segment length × parallel runs); allowance added only when explicitly specified',
    serviceType,
    baseLengthM: round(baseLengthM),
    explicitAllowancePercent,
    allowanceM: round(allowanceM),
    totalLengthM: round(baseLengthM + allowanceM),
    rows,
    limitations: ['Route geometry and segment lengths must come from coordinated layouts, risers, schematics or model data.', 'Fittings, joints, terminations, valves, cable glands, supports and accessories are separate schedule/detail takeoffs.', 'No default slack, waste or routing allowance is assumed.']
  };
}

module.exports = { calculateMasonryWall, calculateRectangularDuctwork, calculateRoutedServices };
