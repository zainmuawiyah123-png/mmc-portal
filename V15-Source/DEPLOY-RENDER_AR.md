# نشر وتحديث بوابة MMC على Render

## المتطلبات
- حساب على [render.com](https://render.com) (مجاني يكفي للتجربة)
- مستودع GitHub أو GitLab فيه ملفات المشروع (بما فيها `Dockerfile` و `render.yaml`)

---

## أ) النشر لأول مرة (من الصفر)

### 1. ارفع المشروع إلى GitHub
من جهازك بعد فك ضغط المجلد المحسّن:

```bash
cd mmc-proposal-kit
git init
git add .
git commit -m "MMC portal ready for Render"
# أنشئ مستودعاً جديداً على GitHub ثم:
git remote add origin https://github.com/YOUR_USER/mmc-portal.git
git branch -M main
git push -u origin main
```

> لا ترفع مجلد `node_modules` ولا ملف `.env` (موجودان في `.gitignore`).

### 2. أنشئ الخدمة على Render

**الطريقة الأسهل — Blueprint:**
1. ادخل [dashboard.render.com](https://dashboard.render.com)
2. **New** → **Blueprint**
3. اربط مستودع GitHub واختر الفرع `main`
4. Render يقرأ `render.yaml` تلقائياً
5. اضغط **Apply**

**أو يدوياً — Web Service:**
1. **New** → **Web Service**
2. اربط المستودع
3. Runtime: **Docker**
4. Instance: **Starter** (أو Free للتجربة)
5. أضف **Persistent Disk**:
   - Name: `mmc-data`
   - Mount path: `/data`
   - Size: 1–2 GB
6. Environment variables (مهم):

| المفتاح | القيمة | ملاحظة |
|---------|--------|--------|
| `NODE_ENV` | `production` | ثابت |
| `COOKIE_SECURE` | `true` | لأن الموقع على HTTPS |
| `JWT_SECRET` | اضغط Generate | سر قوي عشوائي |
| `DB_PATH` | `/data/portal.db` | على القرص الدائم |
| `UPLOAD_DIR` | `/data/uploads` | على القرص الدائم |
| `BACKUP_DIR` | `/data/backups` | على القرص الدائم |
| `ADMIN_EMAIL` | بريدك الحقيقي | مثال: `admin@yourdomain.com` |
| `ADMIN_PASSWORD` | كلمة مرور قوية | غيّرها فوراً |
| `ADMIN_NAME` | مدير النظام | اختياري |

7. **Create Web Service** وانتظر حتى تصبح الحالة **Live**.

### 3. أول دخول بعد النشر
- رابط الموقع يظهر في أعلى صفحة الخدمة على Render (مثل `https://mmc-portal-xxxx.onrender.com`)
- سجّل الدخول من:
  `https://YOUR-SERVICE.onrender.com/portal/pt-9f3c7a1e5b2d/login.html`
- استخدم البريد وكلمة المرور التي وضعتها في `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- بوابة الإدارة:
  `https://YOUR-SERVICE.onrender.com/admin/index.html`

---

## ب) التحديث لاحقاً (بعد تعديل الكود)

### الطريقة العادية (موصى بها)
1. عدّل الملفات على جهازك
2. ادفع إلى GitHub:

```bash
git add .
git commit -m "تحديث: موعد الإغلاق + بوابة الإدارة"
git push origin main
```

3. Render يكتشف الدفع تلقائياً ويعيد البناء والنشر (**Auto-Deploy**).
4. راقب السجلات من تبويب **Logs** حتى ترى:
   - `تم إنشاء المستخدم` أو `موجود مسبقاً`
   - `الخادم يستمع على المنفذ...`

> القرص الدائم (`/data`) **لا يُمسح** عند إعادة النشر، فتبقى قاعدة البيانات والملفات المرفوعة.

### إن أردت إعادة النشر يدوياً
- من لوحة الخدمة: **Manual Deploy** → **Deploy latest commit**

### تغيير كلمة مرور المدير فقط
- من **Environment** غيّر `ADMIN_PASSWORD` ثم **Manual Deploy**
- أو من داخل الخدمة بعد الدخول (إن أضفت لاحقاً صفحة تغيير كلمة المرور)
- أو شغّل سكربت seed يدوياً عبر **Shell** إن كان متاحاً على خطتك

---

## ج) روابط مهمة بعد النشر

| الصفحة | المسار |
|--------|--------|
| الصحة | `/api/health` |
| تسجيل الدخول | `/portal/pt-9f3c7a1e5b2d/login.html` |
| بوابة الإدارة | `/admin/index.html` |
| المشتريات | `/procurement/index.html` |
| المقاول | `/bid/index.html` |
| الفهرس العربي | `/index-ar.html` |

---

## د) مشاكل شائعة وحلولها

| المشكلة | الحل |
|---------|------|
| الخدمة تنام (Free plan) | الخطة المجانية تنام بعد ~15 دقيقة بدون زوار. استخدم Starter أو افتح الرابط ليوقظها |
| «تعذّر الاتصال بالخادم» | تأكد أنك تفتح رابط `https://...onrender.com` وليس ملفاً محلياً |
| فشل البناء (better-sqlite3) | Dockerfile يثبّت `python3 make g++` — لا تحذفها |
| اختفاء البيانات بعد Deploy | تأكد أن القرص مثبت على `/data` وأن `DB_PATH=/data/portal.db` |
| JWT_SECRET ضعيف | استخدم Generate في لوحة Environment ولا تترك القيمة الافتراضية |
| الكوكيز لا تعمل | `COOKIE_SECURE=true` مطلوب مع HTTPS |

---

## هـ) نصائح إنتاج

1. غيّر `ADMIN_EMAIL` و `ADMIN_PASSWORD` إلى قيمك الحقيقية قبل أي استخدام جدي.
2. احفظ نسخة من `JWT_SECRET` في مكان آمن (إعادة توليده تسجّل خروج الجميع).
3. للملفات الكثيرة لاحقاً يمكن التحويل إلى S3/R2 عبر `STORAGE_DRIVER=s3` ومتغيرات S3.
4. راقب `/api/health` بعد كل نشر للتأكد أن الخدمة سليمة.
