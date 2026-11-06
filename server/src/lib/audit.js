'use strict';
/**
 * سجل تدقيق بسيط لعمليات الرفع/التحميل/الحذف/النسخ الاحتياطي.
 * لا يفشل الطلب الأساسي إذا فشل التسجيل — التدقيق ثانوي دائماً.
 */
const { getDB } = require('../db');

/**
 * @param {object} e
 * @param {string} e.action  upload | download | delete | signed_url | backup | restore | migrate
 * @param {string} [e.entity] file | tender | db | system
 * @param {string} [e.entityId]
 * @param {string} [e.userId]
 * @param {string} [e.actor]  معرّف المستخدم أو 'system'
 * @param {string} [e.driver] local | s3
 * @param {object} [e.detail] يُخزَّن JSON
 * @param {string} [e.ip]
 * @param {boolean} [e.ok]
 */
function audit(e) {
  try {
    const db = getDB();
    db.prepare(`INSERT INTO audit_log (action, entity, entity_id, user_id, actor, driver, detail, ip, ok)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(
      String(e.action || 'unknown'),
      e.entity || null,
      e.entityId || null,
      e.userId || null,
      e.actor || e.userId || 'system',
      e.driver || null,
      e.detail ? JSON.stringify(e.detail).slice(0, 4000) : null,
      e.ip || null,
      e.ok === false ? 0 : 1
    );
  } catch (err) {
    console.warn('[audit] تعذّر تسجيل الحدث:', err.message);
  }
}

/** يقرأ آخر الأحداث — يُستخدم في صفحة التشخيص */
function recentAudit(limit = 50) {
  try {
    const rows = getDB().prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ ...r, detail: r.detail ? safeJson(r.detail) : null }));
  } catch (_) { return []; }
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return s; } }

module.exports = { audit, recentAudit };
