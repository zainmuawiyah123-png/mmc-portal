# MMC AI — إعداد نسخ قاعدة البيانات إلى Cloudflare R2

هذا الإعداد مخصص لنسخ SQLite الاحتياطية فقط. لا يغيّر تخزين ملفات المشاريع والرسومات، الذي يبقى على Supabase Storage.

## متغيرات Render المطلوبة (تُضاف بعد اعتماد الاختبار)

- `BACKUP_S3_ENABLED=true`
- `BACKUP_S3_ENDPOINT=https://<Cloudflare-Account-ID>.r2.cloudflarestorage.com`
- `BACKUP_S3_REGION=auto`
- `BACKUP_S3_BUCKET=mmc-ai-backups`
- `BACKUP_S3_ACCESS_KEY_ID=<R2 Access Key ID>`
- `BACKUP_S3_SECRET_ACCESS_KEY=<R2 Secret Access Key>`
- `BACKUP_S3_FORCE_PATH_STYLE=true`
- `BACKUP_UPLOAD=true`

لا تضع الأسرار في GitHub أو المحادثة أو ملفات الكود. تُدخل القيم مباشرة في Environment داخل Render.

## فصل التخزين

- `STORAGE_DRIVER` و`S3_*` تبقى كما هي لتخزين ملفات التطبيق.
- `BACKUP_S3_*` مخصصة حصراً لرفع النسخ إلى bucket النسخ.
- رفع النسخة يُتحقق منه بتنزيلها من R2 ومقارنة SHA-256.
- لا تنفذ هذه النسخة حذفاً سحابياً تلقائياً؛ الاستبقاء المحلي فقط. لن نسمح لمهمة الاستبقاء بلمس bucket ملفات المشاريع.

## قبل تفعيل الإعداد

1. لا تنشر هذا الفرع على Render قبل تحديد مصير قاعدة البيانات الحالية الموجودة في `/tmp/mmc-ai-staging.db`.
2. نشر الكود قد يعيد تشغيل الخدمة، وملف SQLite المؤقت قد يضيع عند إعادة التشغيل.
3. بعد حفظ نسخة مؤكدة، يُنشر الفرع بموافقة صريحة، ثم تُضاف متغيرات R2 أعلاه دون تعديل متغيرات Supabase.
4. نتحقق من وجود ملف `.db.gz` وملف البيان `.json` في bucket، ومن تطابق checksum، ثم نختبر الاستعادة في قاعدة مؤقتة منفصلة.

## ملاحظة تشغيلية

Render Free لا يوفر Shell أو Persistent Disk في الخدمة الحالية حسب ما تم التحقق منه. لذلك لا يمكن تشغيل سكربت النسخ يدوياً من Shell أو ضمان بقاء النسخة المحلية بعد restart. كما أن هذا التعديل وحده لا ينقل SQLite إلى PostgreSQL؛ ذلك يتطلب مشروع ترحيل مستقل واختبارات توافق لجميع استعلامات التطبيق.
