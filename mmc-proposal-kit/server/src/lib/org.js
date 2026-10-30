'use strict';
/**
 * توثيق الجهات (المشتريات والمكاتب الاستشارية) + بيانات الدول الخليجية.
 */
const { getDB } = require('../db');
const config = require('../config');

/* tz: فرق التوقيت الثابت عن UTC (لا توقيت صيفي في هذه الدول) */
const COUNTRIES = {
  JO: { ar: 'الأردن', en: 'Jordan', tz: '+03:00', currency: 'JOD' },
  SA: { ar: 'السعودية', en: 'Saudi Arabia', tz: '+03:00', currency: 'SAR' },
  AE: { ar: 'الإمارات', en: 'United Arab Emirates', tz: '+04:00', currency: 'AED' },
  KW: { ar: 'الكويت', en: 'Kuwait', tz: '+03:00', currency: 'KWD' },
  QA: { ar: 'قطر', en: 'Qatar', tz: '+03:00', currency: 'QAR' },
  BH: { ar: 'البحرين', en: 'Bahrain', tz: '+03:00', currency: 'BHD' },
  OM: { ar: 'سلطنة عُمان', en: 'Oman', tz: '+04:00', currency: 'OMR' }
};
const ORG_TYPES = {
  ministry: 'وزارة أو جهة حكومية',
  municipality: 'بلدية أو أمانة',
  company: 'شركة أو مؤسسة',
  consultancy: 'مكتب استشاري',
  developer: 'مطوّر عقاري',
  other: 'أخرى'
};
const ORG_TYPES_EN = {
  ministry: 'Ministry or government body', municipality: 'Municipality', company: 'Company or establishment',
  consultancy: 'Consulting office', developer: 'Real-estate developer', other: 'Other'
};
/* عملات العروض المالية التي يقدّمها المقاول */
const BID_CURRENCIES = ['JOD', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'USD'];
/* وحدات من العملة لكل 1 دولار — الربط الرسمي الثابت فقط. الدينار الكويتي غير مربوط بالدولار فتُصدَر فواتيره بالدولار */
const PEG = { USD: 1, JOD: 0.709, SAR: 3.75, AED: 3.6725, QAR: 3.64, BHD: 0.376, OMR: 0.3845 };
const DECIMALS = { BHD: 3, OMR: 3 };
const INVOICE_CURRENCIES = Object.keys(PEG);

function convertUsd(usd, currency) {
  const rate = PEG[currency];
  const d = DECIMALS[currency] || 2;
  return Math.round(usd * rate * 10 ** d) / 10 ** d;
}

function tzOf(country) { return (COUNTRIES[country] || COUNTRIES.JO).tz; }

function getVerification(userId) {
  return getDB().prepare('SELECT * FROM org_verifications WHERE user_id = ?').get(userId) || null;
}
function isVerifiedRow(v) {
  return !!v && v.status === 'verified' && (!v.expires_at || v.expires_at > Math.floor(Date.now() / 1000));
}
/** هل يحق لهذا المستخدم نشر عطاءات؟ (المدير مستثنى، وإيقاف الشرط من الإعدادات) */
function canPublish(user) {
  if (!config.REQUIRE_ORG_VERIFICATION || user.role === 'admin') return true;
  return isVerifiedRow(getVerification(user.id));
}
function ownerVerified(userId) {
  if (!config.REQUIRE_ORG_VERIFICATION) return true;
  const u = getDB().prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (u && u.role === 'admin') return true;
  return isVerifiedRow(getVerification(userId));
}
function issuerOf(userId) {
  const v = getVerification(userId);
  if (!v) return { name: null, verified: false, country: null };
  return { name: v.org_name, type: v.org_type, country: v.country, onBehalfOf: v.on_behalf_of || null, verified: isVerifiedRow(v) };
}

module.exports = { COUNTRIES, ORG_TYPES, ORG_TYPES_EN, BID_CURRENCIES, INVOICE_CURRENCIES, PEG, convertUsd, tzOf, getVerification, isVerifiedRow, canPublish, ownerVerified, issuerOf };
