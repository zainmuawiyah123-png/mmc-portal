'use strict';
const { getDB } = require('../db');
const isEvaluator = (userId, tenderId) => !!getDB().prepare('SELECT 1 FROM tender_evaluators WHERE tender_id=? AND user_id=?').get(tenderId, userId);
const isFinalized = (tenderId) => !!(getDB().prepare('SELECT finalized_at FROM tender_committee WHERE tender_id=?').get(tenderId) || {}).finalized_at;
const bidderLabel = (i) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
module.exports = { isEvaluator, isFinalized, bidderLabel };
