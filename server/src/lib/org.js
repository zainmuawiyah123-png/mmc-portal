'use strict';
/**
 * توثيق الجهات (المشتريات والمكاتب الاستشارية) + بيانات الدول الخليجية.
 */
const { getDB, uid } = require('../db');
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

/* ---------- الجهة والأدوار ---------- */
const ORG_ROLES = {
  manager: { ar: 'مدير الجهة', en: 'Organization manager' },
  requester: { ar: 'مالك / طالب الخدمة', en: 'Owner / requester' },
  projects: { ar: 'دائرة المشاريع', en: 'Projects department' },
  procurement: { ar: 'المشتريات', en: 'Procurement' },
  finance: { ar: 'المالية', en: 'Finance' }
};
const PUBLIC_DOC_KINDS = ['drawings', 'specifications', 'boq', 'conditions', 'particular_conditions'];
const DOC_KINDS = ['brief', ...PUBLIC_DOC_KINDS, 'internal'];
const FIDIC_BOOKS = {
  red: { ar: 'الكتاب الأحمر — أعمال تصمّمها الجهة', en: 'Red Book — works designed by the Employer' },
  yellow: { ar: 'الكتاب الأصفر — المعدات والتصميم والبناء', en: 'Yellow Book — Plant & Design-Build' },
  silver: { ar: 'الكتاب الفضي — التسليم على المفتاح EPC', en: 'Silver Book — EPC/Turnkey' },
  green: { ar: 'الكتاب الأخضر — العقد المختصر', en: 'Green Book — Short Form' },
  other: { ar: 'عقد آخر / شروط مخصصة', en: 'Other / bespoke conditions' }
};
const FIDIC_EDITIONS = ['1999', '2017', 'other'];
const FIDIC_URL = 'https://fidic.org';

function membership(userId) {
  return getDB().prepare(`SELECT m.org_id, m.role, o.name org_name, o.created_by, o.require_approval, o.country org_country
    FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ?`).get(userId) || null;
}
/** يضمن أن لحساب المشتريات جهة (ينشئ جهة بصفة مدير إن لم توجد) */
function ensureOrg(user) {
  if (!user || user.role !== 'buyer') return null;
  const m = membership(user.id);
  if (m) return m;
  const db = getDB();
  const id = uid('org_');
  const v = db.prepare('SELECT org_name FROM org_verifications WHERE user_id = ?').get(user.id);
  db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, created_by) VALUES (?,?,?)').run(id, (v && v.org_name) || user.company || user.name || 'جهة', user.id);
    db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,'manager')").run(id, user.id);
    db.prepare('UPDATE org_verifications SET org_id = ? WHERE user_id = ? AND org_id IS NULL').run(id, user.id);
    db.prepare('UPDATE tenders SET org_id = ? WHERE user_id = ? AND org_id IS NULL').run(id, user.id);
  })();
  return membership(user.id);
}
/** صاحب الاشتراك الذي تُحسب عليه باقة الجهة */
function billingUserId(user) {
  const m = user && user.role === 'buyer' ? membership(user.id) : null;
  return m ? m.created_by : user.id;
}
function orgMemberIds(orgId) {
  return getDB().prepare('SELECT user_id FROM org_members WHERE org_id = ?').all(orgId).map((r) => r.user_id);
}
/** هل يحق للمستخدم إدارة عطاءات يملكها مستخدم آخر (نفس الجهة وبدور مشتريات أو مدير)؟ */
function canManageUserTenders(user, ownerUserId) {
  if (user.role === 'admin' || ownerUserId === user.id) return true;
  const mine = membership(user.id), theirs = membership(ownerUserId);
  return !!(mine && theirs && mine.org_id === theirs.org_id && ['manager', 'procurement'].includes(mine.role));
}

function getVerification(userId) {
  const db = getDB();
  const m = membership(userId);
  if (m) {
    const v = db.prepare('SELECT * FROM org_verifications WHERE org_id = ?').get(m.org_id);
    return v || null;   // عضو في جهة: توثيق الجهة وحده هو المعتبر
  }
  return db.prepare('SELECT * FROM org_verifications WHERE user_id = ?').get(userId) || null;
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

module.exports = { ORG_ROLES, PUBLIC_DOC_KINDS, DOC_KINDS, FIDIC_BOOKS, FIDIC_EDITIONS, FIDIC_URL, membership, ensureOrg, billingUserId, orgMemberIds, canManageUserTenders, COUNTRIES, ORG_TYPES, ORG_TYPES_EN, BID_CURRENCIES, INVOICE_CURRENCIES, PEG, convertUsd, tzOf, getVerification, isVerifiedRow, canPublish, ownerVerified, issuerOf };
