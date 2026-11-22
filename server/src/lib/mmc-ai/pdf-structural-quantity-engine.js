'use strict';

function calculateIsolatedFootingConcrete({ schedule, planMarkCounts, evidence } = {}) {
  if (!Array.isArray(schedule) || !schedule.length || !Array.isArray(planMarkCounts) || !planMarkCounts.length) {
    throw new TypeError('Footing schedule and plan mark counts are required');
  }
  if (!evidence || !Number.isInteger(evidence.schedulePage) || !Number.isInteger(evidence.planPage) ||
      !evidence.documentId || !evidence.reviewedBy) {
    throw new TypeError('Document, schedule page, plan page and reviewer evidence are required');
  }
  const scheduleByMark = new Map();
  for (const row of schedule) {
    const mark = String(row?.mark || '').trim().toUpperCase();
    if (!mark || scheduleByMark.has(mark)) throw new TypeError('Footing marks must be present and unique');
    for (const key of ['lengthM', 'widthM', 'depthM']) {
      if (!Number.isFinite(row[key]) || row[key] <= 0) throw new TypeError(mark + ': ' + key + ' must be a positive measured value');
    }
    scheduleByMark.set(mark, { ...row, mark });
  }
  const countsByMark = new Map();
  for (const row of planMarkCounts) {
    const mark = String(row?.mark || '').trim().toUpperCase();
    if (!mark || countsByMark.has(mark)) throw new TypeError('Plan mark counts must be present and unique');
    if (!Number.isInteger(row.count) || row.count <= 0) throw new TypeError(mark + ': plan count must be a positive integer');
    countsByMark.set(mark, row.count);
  }
  const unmatchedSchedule = [...scheduleByMark.keys()].filter(mark => !countsByMark.has(mark));
  const unmatchedPlan = [...countsByMark.keys()].filter(mark => !scheduleByMark.has(mark));
  if (unmatchedSchedule.length || unmatchedPlan.length) {
    return {
      engine: 'mmc-isolated-footing-concrete-v1',
      status: 'incomplete_schedule_plan_match',
      unmatchedScheduleMarks: unmatchedSchedule,
      unmatchedPlanMarks: unmatchedPlan,
      items: [], totalVolumeM3: null,
      approvalEligible: false
    };
  }
  const items = [...scheduleByMark.values()].map(row => {
    const count = countsByMark.get(row.mark);
    const volumeEachM3 = row.lengthM * row.widthM * row.depthM;
    return {
      mark: row.mark, count,
      dimensionsM: { length: row.lengthM, width: row.widthM, depth: row.depthM },
      formula: count + ' × ' + row.lengthM + ' × ' + row.widthM + ' × ' + row.depthM,
      volumeEachM3: Number(volumeEachM3.toFixed(3)),
      totalVolumeM3: Number((count * volumeEachM3).toFixed(3)),
      schedulePage: evidence.schedulePage,
      planPage: evidence.planPage,
      scheduleSource: row.source || 'dimension_schedule_requires_verification',
      countSource: row.countSource || 'plan_mark_count_requires_verification',
      status: 'measured_draft_requires_engineering_review'
    };
  });
  const totalVolumeM3 = Number(items.reduce((sum, item) => sum + item.totalVolumeM3, 0).toFixed(3));
  return {
    engine: 'mmc-isolated-footing-concrete-v1',
    documentId: evidence.documentId,
    discipline: 'structural',
    category: 'isolated_footing_concrete',
    unit: 'm3',
    items,
    totalVolumeM3,
    sourcePages: [evidence.planPage, evidence.schedulePage],
    reviewer: evidence.reviewedBy,
    status: 'measured_draft_requires_engineering_review',
    approvalEligible: false,
    exclusions: [
      'Blinding concrete is excluded unless separately dimensioned and counted.',
      'Pedestals, column necks, grade beams and continuous strip footings are excluded.',
      'Excavation, backfill, reinforcement, laps, hooks and wastage are excluded.',
      'No missing dimensions or counts are defaulted or estimated.'
    ]
  };
}

module.exports = { calculateIsolatedFootingConcrete };
