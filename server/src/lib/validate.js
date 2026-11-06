'use strict';
/**
 * مخططات التحقق (zod) لكل نقطة API.
 */
const { z } = require('zod');
const { E } = require('./errors');

const email = z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح.');
const password = z.string().min(8, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.').max(200, 'كلمة المرور طويلة جداً.');
const name = z.string().trim().min(2, 'الاسم قصير جداً.').max(120, 'الاسم طويل جداً.');

const registerSchema = z.object({
  name,
  email,
  password,
  company: z.union([z.string().trim().max(160), z.null()]).optional()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v)),
  role: z.enum(['contractor', 'buyer', 'consultant']).default('contractor'),
  country: z.enum(['JO', 'SA', 'AE']).default('JO')
});

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'أدخل كلمة المرور.')
});

const tenderCreateSchema = z.object({
  name: z.string().trim().min(2, 'اسم المشروع مطلوب (حرفان على الأقل).').max(200, 'اسم المشروع طويل جداً.'),
  authority: z.union([z.string().trim().max(200), z.null()]).optional()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v)),
  closing: z.union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ الإغلاق يجب أن يكون بصيغة YYYY-MM-DD.'),
    z.null()
  ]).optional().transform((v) => (v === undefined || v === null || v === '' ? null : v)),
  notes: z.union([z.string().trim().max(4000), z.null()]).optional()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v))
});

const tenderUpdateSchema = z.object({
  name: z.string().trim().min(2, 'اسم المشروع مطلوب.').max(200).optional(),
  authority: z.union([z.string().trim().max(200), z.null()]).optional(),
  closing: z.union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة.'),
    z.literal(''),
    z.null()
  ]).optional(),
  notes: z.union([z.string().trim().max(4000), z.null()]).optional(),
  status: z.enum(['new', 'proc', 'ready'], { message: 'حالة غير معروفة. القيم المقبولة: new, proc, ready.' }).optional()
});

const requestCreateSchema = z.object({
  kind: z.enum(['note', 'change', 'question'], { message: 'نوع الطلب غير معروف.' }).default('note'),
  text: z.string().trim().min(3, 'اكتب نص الطلب (3 أحرف على الأقل).').max(4000, 'النص طويل جداً.')
});

const planChangeSchema = z.object({
  planKey: z.enum(['free', 'starter', 'pro', 'ent'], { message: 'باقة غير معروفة.' })
});

/** يحوّل خطأ zod إلى تفاصيل حقول مفهومة */
function zodDetails(err) {
  return err.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
}

function parse(schema, data) {
  const r = schema.safeParse(data || {});
  if (r.success) return r.data;
  throw E.validation('بيانات غير صالحة. راجع الحقول المعلَّمة.', zodDetails(r.error));
}

module.exports = {
  registerSchema, loginSchema, tenderCreateSchema, tenderUpdateSchema,
  requestCreateSchema, planChangeSchema, parse, zodDetails
};
