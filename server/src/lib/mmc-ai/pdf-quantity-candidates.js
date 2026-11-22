'use strict';

const round = (value, places = 6) => Number(value.toFixed(places));
const normalizeText = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();

function deriveScaleCandidates({ dimensions = [], associations = [], geometry } = {}) {
  if (!Array.isArray(dimensions) || !Array.isArray(associations) ||
      !geometry || !Array.isArray(geometry.paths)) {
    throw new TypeError('Dimension evidence, spatial associations and vector geometry are required');
  }
  const pathByIndex = new Map(geometry.paths.map((path, index) => [index + 1, path]));
  const candidates = [];
  for (const dimension of dimensions) {
    if (dimension?.kind !== 'explicit_length' ||
        !Array.isArray(dimension.normalizedValuesMm) ||
        dimension.normalizedValuesMm.length !== 1 ||
        !Number.isFinite(dimension.normalizedValuesMm[0]) ||
        dimension.normalizedValuesMm[0] <= 0) continue;
    const raw = normalizeText(dimension.raw);
    const association = associations.find(item =>
      normalizeText(item.text).includes(raw) &&
      Array.isArray(item.nearbyVectorPaths) && item.nearbyVectorPaths.length);
    if (!association) continue;
    const nearest = association.nearbyVectorPaths[0];
    const path = pathByIndex.get(nearest.pathIndex);
    if (!path || !Number.isFinite(path.lengthUnits) || path.lengthUnits <= 0) continue;
    const mmPerUnit = dimension.normalizedValuesMm[0] / path.lengthUnits;
    if (!Number.isFinite(mmPerUnit) || mmPerUnit <= 0) continue;
    candidates.push({
      id: 'scale-p' + String(dimension.page || 1) + '-path-' + nearest.pathIndex,
      page: dimension.page || 1,
      rawDimension: dimension.raw,
      knownDimensionMm: dimension.normalizedValuesMm[0],
      pathIndex: nearest.pathIndex,
      pathLengthDrawingUnits: path.lengthUnits,
      associationDistancePx: nearest.distancePx,
      mmPerDrawingUnit: round(mmPerUnit, 9),
      status: 'single_dimension_scale_candidate_requires_confirmation',
      applied: false,
      source: 'explicit_unit_dimension_callout_and_nearest_vector_path_candidate'
    });
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.page + ':' + candidate.pathIndex;
    if (!seen.has(key)) { seen.add(key); unique.push(candidate); }
  }
  const groups = new Map();
  for (const candidate of unique) {
    if (!groups.has(candidate.page)) groups.set(candidate.page, []);
    groups.get(candidate.page).push(candidate);
  }
  const pages = [...groups.entries()].map(([page, items]) => {
    const values = items.map(item => item.mmPerDrawingUnit).sort((a,b)=>a-b);
    const median = values.length % 2 ? values[(values.length-1)/2] : (values[values.length/2-1]+values[values.length/2])/2;
    const deviations = items.map(item => Math.abs(item.mmPerDrawingUnit-median)/median);
    const consistent = items.length >= 2 && deviations.every(value => value <= 0.02);
    const status = consistent ? 'consistent_multi_dimension_scale_candidate_requires_confirmation' :
      items.length >= 2 ? 'conflicting_scale_candidates_do_not_calibrate' :
      'single_dimension_scale_candidate_requires_confirmation';
    return {
      page,
      status,
      candidateMmPerDrawingUnit: items.length ? round(median, 9) : null,
      independentDimensionCount: items.length,
      relativeDeviationMax: deviations.length ? round(Math.max(...deviations), 6) : null,
      sourceCandidateIds: items.map(item => item.id),
      candidates: items,
      calibrated: false,
      notice: consistent
        ? 'Two or more independent dimension-to-vector matches agree within 2%; engineer/user confirmation is still required.'
        : items.length >= 2
          ? 'Dimension-to-vector matches disagree by more than 2%; scale is withheld.'
          : 'Only one dimension-to-vector match exists; it is insufficient to calibrate the page.'
    };
  });
  return {
    engine: 'mmc-pdf-scale-evidence-v1',
    pages,
    limitations: [
      'Nearest vector paths may be dimension lines, object edges or unrelated geometry; spatial proximity alone does not prove correspondence.',
      'A printed dimension callout is not automatically treated as a measured line.',
      'No scale is applied and no metric quantity is produced until the scale is explicitly confirmed.',
      'Each PDF page is calibrated independently; a scale from one viewport/page is never copied to another.'
    ]
  };
}

function applyConfirmedPageScale({ geometry, mmPerDrawingUnit, confirmedBy, confirmationNote } = {}) {
  if (!geometry || !Array.isArray(geometry.paths)) throw new TypeError('Vector geometry is required');
  if (!Number.isFinite(mmPerDrawingUnit) || mmPerDrawingUnit <= 0) throw new TypeError('A positive confirmed mmPerDrawingUnit is required');
  if (confirmedBy !== 'user' && confirmedBy !== 'engineer') throw new TypeError('Scale confirmation must identify user or engineer');
  const metresPerUnit = mmPerDrawingUnit / 1000;
  const paths = geometry.paths.map((path, index) => ({
    pathIndex: index + 1,
    closed: path.closed === true,
    lengthM: Number.isFinite(path.lengthUnits) ? round(path.lengthUnits * metresPerUnit, 4) : null,
    areaM2: path.closed === true && Number.isFinite(path.areaSquareUnits)
      ? round(path.areaSquareUnits * metresPerUnit * metresPerUnit, 4) : null,
    sourceDrawingUnits: { length: path.lengthUnits ?? null, area: path.areaSquareUnits ?? null },
    semanticType: 'unclassified_vector_geometry',
    boqEligible: false,
    reviewStatus: 'requires_element_classification_and_engineering_review'
  }));
  return {
    engine: 'mmc-pdf-calibrated-geometry-measurements-v1',
    calibration: {
      mmPerDrawingUnit,
      metresPerDrawingUnit: round(metresPerUnit, 12),
      confirmedBy,
      confirmationNote: String(confirmationNote || '').slice(0, 500) || null
    },
    paths,
    totals: {
      pathCount: paths.length,
      measuredLengthM: round(paths.reduce((sum, path) => sum + (path.lengthM || 0), 0), 4),
      measuredClosedAreaM2: round(paths.reduce((sum, path) => sum + (path.areaM2 || 0), 0), 4)
    },
    status: 'metric_geometry_measured_unclassified',
    approvalEligible: false,
    limitations: [
      'These are calibrated vector path measurements, not yet net BOQ quantities.',
      'Dimension lines, leaders, grids, annotations and duplicate/overlapping paths may be included.',
      'Closed path area is not automatically floor, slab, wall, excavation or concrete area.',
      'No volume, reinforcement weight, material quantity or BIM element is inferred.'
    ]
  };
}

module.exports = { deriveScaleCandidates, applyConfirmedPageScale };
