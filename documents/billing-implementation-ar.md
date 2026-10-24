# تنفيذ الفوترة وإيصالات التحويل — MMC

## المسارات الجديدة

- `POST /api/billing/invoices` إنشاء فاتورة بحالة `pending`.
- `GET /api/billing/invoices` عرض فواتير المستخدم الحالي.
- `GET /api/billing/invoices/:id` عرض تفاصيل فاتورة يملكها المستخدم.
- `POST /api/billing/invoices/:id/receipt` رفع إيصال التحويل في الحقل `receipt` بصيغة PDF أو JPG أو PNG أو WEBP، وبحد أقصى 10 MB.

جميع المسارات تحتاج تسجيل دخول. التخزين يستخدم نفس مشغل التخزين الموجود (`local` أو `s3`) ولا يتم حفظ اسم الملف الأصلي كمفتاح تخزين.

## مثال إنشاء فاتورة من المتصفح

```js
const r = await API.createInvoice({
  planKey: 'pro',
  billingCycle: 'monthly',
  currency: 'JOD',
  paymentMethod: 'cliq',
  notes: 'اشتراك شهر واحد'
});
```

## مثال رفع إيصال

```js
const form = new FormData();
form.append('receipt', fileInput.files[0]);
const r = await fetch('/api/billing/invoices/' + invoiceId + '/receipt', {
  method: 'POST', body: form, credentials: 'include'
});
```

بعد الرفع تبقى الفاتورة `pending` حتى تعتمدها الإدارة. لم تتم إضافة اعتماد الإدارة الآلي في هذه المرحلة حتى لا تُفتح الباقة بمجرد رفع صورة غير موثقة.

## نموذج الفاتورة

النموذج القابل للطباعة موجود في:

`webpages/technical-proposal-kit_v5/documents/invoice-template.html`

وهو يستخدم placeholders مثل `{{invoice_number}}` و`{{amount}}` ليتم استبدالها لاحقاً ببيانات API عند بناء شاشة الفواتير.

## جدول invoices

يخزن رقم الفاتورة والباقة والدورة والعملة والمبلغ وحالة الدفع وبيانات التحويل ومفتاح التخزين والـ SHA-256 للإيصال وتواريخ الإصدار والاستحقاق والدفع.

## انتهاء الاشتراكات

عند ضبط:

```env
SCHEDULER_ENABLED=true
SUBSCRIPTION_EXPIRY_CRON=0 3 * * *
BACKUP_TZ=Asia/Riyadh
```

يشغّل الخادم مهمة يومية الساعة 03:00، فتجد الاشتراكات النشطة التي انتهى `ends_at` الخاص بها، وتحوّلها إلى `expired`، ثم تعيد المستخدم إلى `free` إذا لم توجد له باقة نشطة أخرى.

للاختبار اليدوي:

```bash
npm run expire-subscriptions
```

في Windows:

```powershell
cd server
$env:DB_PATH='./data/portal.db'
npm run expire-subscriptions
```

## قبل الإنتاج

يجب إضافة لوحة إدارة لاعتماد/رفض الإيصالات، وإنشاء سجل أحداث Webhook، ومفاتيح بوابة الدفع في متغيرات البيئة فقط، وعدم اعتبار رفع الإيصال دليلاً على الدفع قبل المطابقة البنكية.
