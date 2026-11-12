'use strict';

/**
 * Compiles reviewed quantity records into a BOQ draft without silently
 * merging unlike specifications, units, locations or duplicate scopes.
 * This is a deterministic compiler, not a pricing engine or approver.
 */
const round = value => Number(value.toFixed(6));
const KEY_FIELDS = ['projectId', 'discipline', 'system', 'description', 'unit', 'itemCode', 'specification', 'measurementBasis'];

function normalizeKey(record) {
  return KEY_FIELDS.map(field => String(record[field] === undefined || record[field] === null ? '' : record[field]).trim().toLowerCase()).join('|');
}
function compileBoq(records, { includeStates = ['measured_ready_for_review', 'approved'], groupBy = KEY_FIELDS } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Array.isArray(includeStates) || includeStates.length === 0) throw new TypeError('includeStates must be a non-empty array');
  if (!Array.isArray(groupBy) || groupBy.length === 0 || groupBy.some(field => !KEY_FIELDS.includes(field))) throw new TypeError('groupBy contains unsupported fields');
  const selected = records.filter(record => includeStates.includes(record.reviewState));
  const groups = new Map();
  const duplicateGroups = new Map();
  for (const record of selected) {
    if (!record || typeof record !== 'object') throw new TypeError('each quantity record must be an object');
    for (const field of ['id', 'projectId', 'discipline', 'system', 'description', 'unit', 'reviewState']) {
      if (typeof record[field] !== 'string' || !record[field].trim()) throw new TypeError('record ' + (record.id || '<unknown>') + ' missing ' + field);
    }
    if (!Number.isFinite(record.quantity) || record.quantity < 0) throw new TypeError('record ' + record.id + ' has invalid quantity');
    if (!record.sources || !record.sources.length || !record.derivation) throw new TypeError('record ' + record.id + ' lacks source or derivation traceability');
    const key = groupBy.map(field => String(record[field] === undefined || record[field] === null ? '' : record[field]).trim().toLowerCase()).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
    if (record.duplicateGroup) {
      if (!duplicateGroups.has(record.duplicateGroup)) duplicateGroups.set(record.duplicateGroup, []);
      duplicateGroups.get(record.duplicateGroup).push(record.id);
    }
  }
  const items = [];
  for (const [key, members] of groups.entries()) {
    const units = [...new Set(members.map(item => item.unit))];
    if (units.length !== 1) throw new Error('cannot aggregate unlike units in group ' + key);
    items.push({
      boqDraftId: 'BOQ-' + (items.length + 1).toString().padStart(5, '0'),
      groupKey: key,
      projectId: members[0].projectId,
      discipline: members[0].discipline,
      system: members[0].system,
      description: members[0].description,
      itemCode: members[0].itemCode || null,
      specification: members[0].specification || null,
      measurementBasis: members[0].measurementBasis || null,
      unit: units[0],
      quantity: round(members.reduce((sum, item) => sum + item.quantity, 0)),
      sourceQuantityRecordIds: members.map(item => item.id),
      sourceCount: members.length,
      // Carry the drawing/document and element lineage onto the BOQ draft row
      // so reviewers can navigate from a quantity back to its measured evidence.
      sourceReferences: members.flatMap(item => (item.sources || []).map(source => ({ ...source }))),
      sourceElementRefs: [...new Set(members.flatMap(item => Array.isArray(item.elementRefs) ? item.elementRefs : []))],
      derivations: members.map(item => ({ quantityRecordId: item.id, ...(item.derivation || {}) })),
      approvalState: members.every(item => item.reviewState === 'approved') ? 'approved' : 'draft_requires_review'
    });
  }
  return {
    status: 'boq_draft',
    itemCount: items.length,
    includedRecordCount: selected.length,
    excludedRecordCount: records.length - selected.length,
    items,
    duplicateWarnings: [...duplicateGroups.entries()].filter(([, ids]) => ids.length > 1).map(([duplicateGroup, recordIds]) => ({
      duplicateGroup, recordIds,
      action: 'manual_resolution_required; records are not silently deleted or merged'
    })),
    limitations: [
      'This produces a draft BOQ only; it does not approve quantities, set rates, calculate taxes or determine contractual measurement rules.',
      'Only records in includeStates are included. Provisional, incomplete, missing-information and conflict records remain excluded by default.',
      'Grouping uses the requested fields; changing groupBy can change aggregation and must be reviewed by a quantity surveyor.',
      'Duplicate warnings require human resolution and are not automatically deducted.'
    ]
  };
}
module.exports = { compileBoq };
