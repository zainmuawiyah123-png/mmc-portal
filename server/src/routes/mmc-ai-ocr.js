'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { getDB, uid } = require('../db');
const { wrap, E } = require('../lib/errors');
const A = require('../lib/auth');
const storage = require('../lib/storage');
const { ocrPdf, inspectOcrRuntime } = require('../lib/mmc-ai/ocr-engine');

const router = express.Router();
router.use(A.requireAuth);

function member(projectId, userId) {
  return getDB().prepare(
    'SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?'
  ).get(projectId, userId) || null;
}

router.get('/ocr/status', wrap(async (req, res) => {
  const runtime = await inspectOcrRuntime();
  res.setHeader('Cache-Control', 'no-store');
  res.status(runtime.available ? 200 : 503).json({ runtime });
}));

router.post('/projects/:projectId/documents/:documentId/ocr/pdf', wrap(async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.user.id;
  const access = member(projectId, userId);
  if (!access || access.status !== 'active') throw E.notFound('المشروع غير موجود.');
  if (!['owner', 'project_manager', 'engineer', 'quantity_surveyor'].includes(access.role)) {
    throw E.forbidden('لا تملك صلاحية تحليل مستندات هذا المشروع.');
  }

  const db = getDB();
  const doc = db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?')
    .get(req.params.documentId, projectId);
  if (!doc) throw E.notFound('المستند غير موجود.');
  if (doc.file_ext !== '.pdf') throw E.validation('OCR متاح حالياً لملفات PDF فقط.');

  const store = storage.getStorage();
  if (!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
  const bytes = await store.get(doc.storage_key);
  if (!Buffer.isBuffer(bytes) || bytes.length !== Number(doc.size_bytes)) {
    throw E.validation('فشل التحقق من حجم المستند المخزن.');
  }
  const actual = crypto.createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(String(doc.sha256 || ''), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
  }

  let result;
  try {
    result = await ocrPdf(bytes, {
      maxPages: req.body?.maxPages,
      dpi: req.body?.dpi
    });
  } catch (error) {
    if (error.code === 'OCR_RUNTIME_UNAVAILABLE') {
      return res.status(503).json({
        error: { code: error.code, message: error.message },
        runtime: error.details
      });
    }
    throw E.validation(error.message || 'تعذر تنفيذ OCR على ملف PDF.');
  }

  db.prepare(
    'INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)'
  ).run(
    uid('aial_'), projectId, userId, 'pdf_ocr_completed', 'document', doc.id,
    JSON.stringify({
      engine: result.engine,
      status: result.status,
      pagesProcessed: result.pagesProcessed,
      characterCount: result.characterCount
    })
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    documentId: doc.id,
    result,
    notice: 'هذه نتيجة OCR نصية مع مواضع الكلمات ودرجة الثقة؛ وليست اعتماداً هندسياً أو حصر كميات.'
  });
}));

module.exports = router;
