'use strict';
/**
 * إعدادات الخادم — تُقرأ من متغيرات البيئة عند الإقلاع.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');          // .../server

/**
 * محمّل ملف .env مبسّط بلا أي تبعية خارجية.
 * يقرأ <ROOT>/.env إن وُجد ويضعه في process.env دون أن يطغى على
 * متغيّرات البيئة الحقيقية (الأولوية لما يأتي من الصدفة/الحاوية).
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    // إزالة علامات التنصيص المحيطة إن وُجدت
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // تعليق في نهاية السطر غير المُنصّص:  KEY=value   # تعليق
      const hash = val.indexOf(' #');
      if (hash > -1) val = val.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.resolve(ROOT, '..', '.env'));

const v = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const config = {
  ROOT,
  NODE_ENV: v('NODE_ENV', 'development'),
  PORT: Number(v('PORT', 4000)),
  HOST: v('HOST', '0.0.0.0'),

  DB_PATH: v('DB_PATH', path.join(ROOT, 'data', 'portal.db')),
  UPLOAD_DIR: v('UPLOAD_DIR', path.join(ROOT, 'uploads')),

  JWT_SECRET: v('JWT_SECRET', 'dev-insecure-secret-CHANGE-ME'),
  REQUIRE_ORG_VERIFICATION: v('REQUIRE_ORG_VERIFICATION', 'true') !== 'false',
  VERIFICATION_DAYS: Number(v('VERIFICATION_DAYS', 365)),
  JWT_TTL: v('JWT_TTL', '7d'),
  COOKIE_NAME: v('COOKIE_NAME', 'tpkit_session'),
  COOKIE_SECURE: v('COOKIE_SECURE', 'false') === 'true',

  MAX_FILE_BYTES: Number(v('MAX_FILE_BYTES', String(25 * 1024 * 1024))),
  MAX_FILES_PER_REQUEST: Number(v('MAX_FILES_PER_REQUEST', 10)),

  /* ============ الواجهة ============ */
  /** جذر الملفات الثابتة. فارغ = webpages/technical-proposal-kit_v5 بجوار الخادم */
  WEB_ROOT: v('WEB_ROOT', ''),

  /* ============ التخزين ============ */
  /** local | s3  — يُحدّد مشغّل التخزين الوحيد المستخدم */
  STORAGE_DRIVER: v('STORAGE_DRIVER', 'local'),
  /** صلاحية الرابط الموقّع بالثواني — قصيرة عمداً (5 دقائق) */
  SIGNED_URL_TTL: Number(v('SIGNED_URL_TTL', 300)),

  /* ============ S3 / R2 / MinIO (تُستخدم فقط عند STORAGE_DRIVER=s3) ============ */
  S3_ENDPOINT: v('S3_ENDPOINT', ''),
  S3_REGION: v('S3_REGION', 'auto'),
  S3_BUCKET: v('S3_BUCKET', ''),
  S3_ACCESS_KEY_ID: v('S3_ACCESS_KEY_ID', ''),
  S3_SECRET_ACCESS_KEY: v('S3_SECRET_ACCESS_KEY', ''),
  /** true لـ R2 و MinIO وكل ما لا يدعم النطاق الفرعي للمجلد */
  S3_FORCE_PATH_STYLE: v('S3_FORCE_PATH_STYLE', 'true') === 'true',

  /* ============ النسخ الاحتياطي ============ */
  /** مسار النسخ الاحتياطية محلياً قبل الرفع */
  BACKUP_DIR: v('BACKUP_DIR', path.join(ROOT, 'backups')),
  /** بادئة المسار داخل السحابة */
  BACKUP_PREFIX: v('BACKUP_PREFIX', 'backups/db'),
  /** سياسة الاستبقاء */
  BACKUP_KEEP_DAILY: Number(v('BACKUP_KEEP_DAILY', 7)),
  BACKUP_KEEP_WEEKLY: Number(v('BACKUP_KEEP_WEEKLY', 4)),
  BACKUP_KEEP_MONTHLY: Number(v('BACKUP_KEEP_MONTHLY', 12)),
  /** رفع النسخة إلى السحابة (يحتاج STORAGE_DRIVER=s3 أو يبقى محلياً فقط) */
  BACKUP_UPLOAD: v('BACKUP_UPLOAD', 'true') === 'true',

  /* ============ الجدولة ============ */
  /** تعطيل كل المهام المجدولة بمتغير واحد */
  SCHEDULER_ENABLED: v('SCHEDULER_ENABLED', 'false') === 'true',
  /** تعبير cron للنسخ الاحتياطي — افتراضي: 02:30 كل يوم */
  BACKUP_CRON: v('BACKUP_CRON', '30 2 * * *'),
  /** فحص الاشتراكات المنتهية يومياً — افتراضي 03:00 بتوقيت المنطقة */
  SUBSCRIPTION_EXPIRY_CRON: v('SUBSCRIPTION_EXPIRY_CRON', '0 3 * * *'),
  OPPORTUNITY_SYNC_ENABLED: v('OPPORTUNITY_SYNC_ENABLED', 'false') === 'true',
  UNGM_ACCESS_TOKEN: v('UNGM_ACCESS_TOKEN', ''),
  OPPORTUNITY_SYNC_CRON: v('OPPORTUNITY_SYNC_CRON', '15 */6 * * *'),
  BACKUP_TZ: v('BACKUP_TZ', 'Asia/Riyadh'),

  /** أصل الواجهة إن كانت تُقدَّم من نطاق مختلف (مثال: موقع ثابت على /sites/). فارغ = نفس الأصل. */
  CORS_ORIGIN: v('CORS_ORIGIN', ''),

  BCRYPT_ROUNDS: Number(v('BCRYPT_ROUNDS', 10))
};

/* بيانات الدفع (تُقرأ من .env وتظهر في كل الصفحات عبر GET /api/payment-info) */
config.PAYMENT = {
  bankName: v('PAYMENT_BANK_NAME', ''),
  accountHolder: v('PAYMENT_ACCOUNT_HOLDER', ''),
  iban: v('PAYMENT_IBAN', '').replace(/\s+/g, '').toUpperCase(),
  swift: v('PAYMENT_SWIFT', '').replace(/\s+/g, '').toUpperCase(),
  cliqAlias: v('PAYMENT_CLIQ_ALIAS', ''),
  contactEmail: v('PAYMENT_CONTACT_EMAIL', '')
};
config.IS_PROD = config.NODE_ENV === 'production';

/**
 * الأسرار المرفوعة مع الكود معروفة علناً — يجب رفضها كأنها افتراضية.
 * القيمة العربية في .env.example تُطابق بعد التطبيع لأنها نص إرشادي.
 */
const KNOWN_WEAK_SECRETS = [
  'dev-insecure-secret-CHANGE-ME',
  'ضع-سراً-قوياً-هنا-ب٤٨-حرفاً-على-الأقل',
  'change-me',
  'secret',
  'changeme'
];

config.IS_DEFAULT_SECRET =
  KNOWN_WEAK_SECRETS.includes(config.JWT_SECRET.trim()) ||
  config.JWT_SECRET.trim().length < 16;

/** فحص مجموع التحقق للآيبان (mod 97) لاكتشاف خطأ الكتابة قبل أن يحوّل عميل أمواله */
function ibanValid(s) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of r) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
config.PAYMENT_IBAN_CONFIGURED = Boolean(config.PAYMENT.iban);
config.PAYMENT_IBAN_VALID = config.PAYMENT_IBAN_CONFIGURED && ibanValid(config.PAYMENT.iban);
if (config.PAYMENT_IBAN_CONFIGURED && !config.PAYMENT_IBAN_VALID) {
  console.warn('[WARN] PAYMENT_IBAN مُدخل لكنه غير صحيح (فشل فحص المجموع) — راجع الآيبان في .env قبل استقبال أي دفعة.');
}

if (config.IS_PROD && config.IS_DEFAULT_SECRET) {
  console.error(
    '[FATAL] JWT_SECRET افتراضي أو ضعيف (أقل من ١٦ حرفاً أو قيمة معروفة) — غير مسموح في الإنتاج.\n' +
    '        ولّد سراً عشوائياً:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
  );
  process.exit(1);
}

module.exports = config;
