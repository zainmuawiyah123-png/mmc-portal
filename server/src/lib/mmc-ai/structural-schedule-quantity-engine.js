'use strict';

/**
 * Auditable structural schedule calculator.
 * It calculates only explicitly supplied footing schedule values and counts.
 * It does not read or classify PDF drawings; upstream extraction must provide
 * evidence references for both the schedule dimensions and plan counts.
 */
function calculateFootingConcreteTakeoff({ footings, units = 'm' } = {}) {
  if (units !== 'm') throw new TypeError('Footing dimensions must be explicitly normalized to metres');
  if (!Array.isArray(footings) || footings.length === 0) {
    throw new TypeError('At least one verified footing schedule row is required');
  }
  const seen = new Set();
  const items = footings.map((row, index) => {
    const code = String(row?.code || '').trim();
    if (!code || seen.has(code)) throw new TypeError('Footing codes must be present and unique');
    seen.add(code);
    const count = row.count;
    const lengthM = row.lengthM;
    const widthM = row.widthM;
    const depthM = row.depthM;
    if (!Number.isInteger(count) || count < 1) throw new TypeError(code + ': a verified positive integer count is required');
    for (const [name, value] of [['lengthM', lengthM], ['widthM', widthM], ['depthM', depthM]]) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(code + ': verified ' + name + ' is required');
    }
    const scheduleEvidence = row.scheduleEvidence;
    const planEvidence = row.planEvidence;
    if (!scheduleEvidence?.page || !scheduleEvidence?.reference ||
        !planEvidence?.page || !planEvidence?.reference) {
      throw new TypeError(code + ': schedule and plan evidence references are both required');
    }
    const unitVolumeM3 = lengthM * widthM * depthM;
    return {
      index: index + 1,
      code,
      count,
      dimensionsM: { length: lengthM, width: widthM, depth: depthM },
      unitVolumeM3: Number(unitVolumeM3.toFixed(4)),
      totalVolumeM3: Number((unitVolumeM3 * count).toFixed(4)),
      formula: count + ' × ' + lengthM + ' × ' + widthM + ' × ' + depthM,
      unit: 'm3',
      evidence: { schedule: scheduleEvidence, plan: planEvidence },
      reviewStatus: 'needs_engineer_review'
    };
  });
  const totalM3 = items.reduce((sum, item) => sum + item.totalVolumeM3, 0);
  return {
    engine: 'mmc-verified-footing-concrete-v1',
    status: 'draft_needs_engineer_review',
    quantityType: 'footing_concrete_gross_volume',
    items,
    summary: { footingTypes: items.length, footingCount: items.reduce((n, item) => n + item.count, 0), totalM3: Number(totalM3.toFixed(4)) },
    exclusions: [
      'Blinding concrete',
      'Pedestals, columns, tie beams and ground beams',
      'Excavation, working space, backfill and disposal',
      'Reinforcement, laps, hooks, chairs and wastage',
      'Openings, steps, slopes and any geometry not represented by the supplied rectangular dimensions'
    ],
    limitations: [
      'Inputs must come from verified drawing extraction or an explicit engineer correction.',
      'This calculator does not extract counts or dimensions from PDF pages.',
      'No quantity is approved until an engineer reviews the cited drawing evidence.'
    ]
  };
}

module.exports = { calculateFootingConcreteTakeoff };
