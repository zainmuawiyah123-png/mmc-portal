'use strict';
/**
 * أخطاء موحّدة برسائل عربية مفهومة للمستخدم النهائي.
 */

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
    this.expose = true;
  }
}

const E = {
  badRequest: (msg = 'طلب غير صالح.', details) => new AppError(400, 'BAD_REQUEST', msg, details),
  validation: (msg = 'بيانات غير صالحة.', details) => new AppError(422, 'VALIDATION', msg, details),
  unauthorized: (msg = 'يجب تسجيل الدخول للمتابعة.') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'لا تملك صلاحية الوصول إلى هذا العنصر.') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'العنصر غير موجود.') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg = 'يوجد تعارض في البيانات.', details) => new AppError(409, 'CONFLICT', msg, details),
  tooLarge: (msg = 'حجم الملف يتجاوز الحد المسموح.') => new AppError(413, 'PAYLOAD_TOO_LARGE', msg),
  unsupported: (msg = 'نوع الملف غير مدعوم.') => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', msg),
  rateLimited: (msg = 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.') => new AppError(429, 'RATE_LIMITED', msg),
  planLimit: (msg = 'وصلت إلى حد باقتك.', details) => new AppError(402, 'PLAN_LIMIT', msg, details),
  server: (msg = 'خطأ داخلي في الخادم.') => new AppError(500, 'INTERNAL', msg)
};

/** middleware: تحويل أي خطأ إلى استجابة JSON موحّدة */
function errorHandler(err, req, res, _next) {
  // multer errors
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'حجم الملف يتجاوز الحد المسموح (' + Math.round((err.limitBytes || 26214400) / 1048576) + ' م.ب).' } });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: { code: 'TOO_MANY_FILES', message: 'عدد الملفات في الطلب يتجاوز الحد المسموح.' } });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'JSON غير صالح في الطلب.' } });
  }
  console.error('[unhandled]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'خطأ داخلي في الخادم. حاول مرة أخرى.' } });
}

/** يلفّ دالة async ويحوّل الاستثناءات إلى errorHandler */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, E, errorHandler, wrap };
