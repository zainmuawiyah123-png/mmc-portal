# إصلاحات mmc-ai-v13 + وضع تجريبي مستقل v2 + صور شبيهة بـ neubuild.ai

هذا الملف يوثّق الإصلاحات المطبّقة + الوضع التجريبي الجديد + الصور المضافة.

---

## 1) إصلاح حرج — زر «تصنيف حسب التخصص» في الواجهة

**الملف:** `webpages/technical-proposal-kit_v5/mmc-ai/index.html`
**السطر:** 2863

### قبل
```js
if(status)status.textContent='تم التصنيف · '+(disciplines.length)+' تخصص';
```

المتغير `disciplines` غير معرّف في النطاق (الموجود هو `data.disciplines`).
هذا يرمي `ReferenceError` بعد أن تكون `__renderDisciplines` قد رسمت البطاقات،
فيدخل الكود `catch` ويستبدل البطاقات برسالة الخطأ.

### بعد
```js
if(status)status.textContent='تم التصنيف · '+((data.disciplines||[]).length)+' تخصص';
```

**التأثير:** الزر يعمل الآن؛ البطاقات تظهر وتبقى ظاهرة بعد الضغط.

---

## 2) إصلاح حرج — BACKFILL / EARTH-FILL تُستبعد بصمت كـ annotation

**الملف:** `server/src/lib/mmc-ai/discipline-layer-classifier.js`

### المشكلة
قاعدة الـ annotation الأولى كانت:
```js
[/PATT|HATCH|FILL|SOLID|TEXT|.../, 'annotation_or_pattern', 'excluded']
```

`FILL` يطابق `BACKFILL` و`EARTH-FILL` كـ substring، فتُستبعد كميات الردم
كاملةً بصمت قبل أن تصل لقاعدة backfill في Civil.

### الإصلاح
1. أُضيفت قاعدة باكورة **قبل** annotation:
   ```js
   [/BACKFILL|EARTH.?FILL|FILL.?DIRT|ردميات|ردم\b/, 'backfill', 'closed_area'],
   ```
2. حُدِّدت `FILL` و`SOLID` و`MARK` بحدود كلمات: `\bFILL\b` / `\bSOLID\b` / `\bMARK\b`

### نتائج الاختبار
| الطبقة | قبل | بعد |
|--------|------|------|
| `C-BACKFILL` | `unclassified / annotation / excluded` | `civil / backfill / closed_area` ✓ |
| `EARTH-FILL` | `unclassified / annotation / excluded` | `unclassified / backfill / closed_area` ✓ |

---

## 3) إصلاح حرج — الكلمة العربية «ري» تُسبّب تطابقات خاطئة

### المشكلة
الرمز `ري` (حرفان) كان مدرجاً في قاعدتي irrigation و landscape كـ substring،
فيطابق:
- `طريق` (road) → landscape ❌ (يجب civil/roads)
- `مجاري` (drainage) → landscape/ducts ❌ (يجب plumbing/drainage)
- `خريطة` (map) → landscape ❌
- `مريض` → landscape ❌

### الإصلاح
- حُذف `ري` المجرّد من كلا القاعدتين، وأُبقي `شبكة ري` (مركّب) فقط.
- أُضيف `طريق` (مفرد) إلى civil keyword (كان `طرق` جمع فقط).
- أُضيف `مجاري` إلى plumbing keyword (كان مفقوداً).
- أُزيل `مجاري` من قاعدة ducts في `CATEGORY_RULES`.

### نتائج الاختبار
| الطبقة | قبل | بعد |
|--------|------|------|
| `مجاري` | `landscape / ducts` ❌ | `plumbing / drainage` ✓ |
| `طريق` | `landscape / roads` ❌ | `civil / roads` ✓ |
| `خريطة` | `landscape / irrigation` ❌ | `unclassified` ✓ |
| `مريض` | `landscape / irrigation` ❌ | `unclassified` ✓ |
| `جدران` | `unclassified` ❌ | `architectural / walls` ✓ |

---

## 4) إصلاح مرتفع — HYDRANT بدون بادئة FP- يصبح غير مصنّف

### المشكلة
`HYDR` كان موجوداً في `CATEGORY_RULES` (hydrants) لكنه **لم يكن** في جدول
الكلمات المفتاحية لـ fire_protection.

### الإصلاح
أُضيفت `HYDR` إلى `KEYWORD_DISCIPLINE` لـ fire_protection.

| الطبقة | قبل | بعد |
|--------|------|------|
| `HYDRANT-MAIN` | `unclassified / hydrants` ❌ | `fire_protection / hydrants` ✓ |
| `HYDRANT-F1` | `unclassified / hydrants` ❌ | `fire_protection / hydrants` ✓ |

---

## 5) إصلاح مرتفع — PUMP الإنجليزية مفقودة من mechanical

### المشكلة
`PUMP` كان في `CATEGORY_RULES` لكنه غير موجود في الكلمات المفتاحية لـ mechanical
(كان موجوداً فقط `مضخة` بالعربية).

### الإصلاح
أُضيفت `PUMP` إلى جدول mechanical keyword.

| الطبقة | قبل | بعد |
|--------|------|------|
| `GEN-PUMP` | `unclassified / pumps` ❌ | `mechanical / pumps` ✓ |

---

## 6) إصلاح متوسط — جمع «جدران» غير مُدرَج

### المشكلة
القواعد كانت تحتوي على `جدار` (مفرد) فقط، لا `جدران` (جمع).

### الإصلاح
أُضيفت `جدران` إلى `CATEGORY_RULES` (walls) و`KEYWORD_DISCIPLINE` (architectural).

---

## 7) وضع تجريبي مستقل v2 (Standalone Demo)

### ملفات جديدة
- `webpages/technical-proposal-kit_v5/mmc-ai/mmc-ai-bundle.js` (79 KB)
  يجمع المحركات الأربعة في سكربت واحد للمتصفح + **حقن الصور تلقائياً**.

- `webpages/technical-proposal-kit_v5/mmc-ai/mmc-ai-demo-backend.js` (24 KB)
  `fetch` shim يعترض كل استدعاء `/api/mmc-ai/*` ويوجّهه إلى تنفيذ في المتصفح
  مدعوم بـ `localStorage`. **جديد في v2: مسار `/boq-imports` مُنفَّذ فعلياً** مع
  محلّل CSV يدعم الفاصلة والفاصلة المنقوطة والحقول المقتبسة والرؤوس العربية
  والإنجليزية.

- `serve_preview.py` (محدَّث) — يخدم الصفحة على `/mmc-ai/workspace` ويسمح
  بتحميل `/mmc-ai-bundle.js` و`/mmc-ai-demo-backend.js` و`/assets/*` بمساراتها
  المطلقة.

### تعديل في index.html (إذا تستخدم نسختك الحالية)
1. **السطر 1237**: `const publicPreview=false` — تعطيل بوابة المعاينة العامة.
2. **رأس `<head>`**: حقن:
   ```html
   <script src="/mmc-ai-bundle.js"></script>
   <script src="/mmc-ai-demo-backend.js"></script>
   ```

### ماذا يعمل في الوضع التجريبي v2
- ✅ إنشاء/عرض المشاريع (localStorage)
- ✅ رفع ملفات DXF (محتوى في الذاكرة)
- ✅ حصر DXF كاملاً (LINE/LWPOLYLINE/CIRCLE/ARC/INSERT)
- ✅ التصنيف حسب التخصص
- ✅ قواعد القياس (25 قاعدة)
- ✅ اعتماد/رفض نتائج الحصر
- ✅ **استيراد BOQ من CSV** (جديد في v2) — يدعم رؤوس عربية وإنجليزية
- ✅ إضافة بنود BOQ يدوياً
- ✅ ملخص المشروع يشمل عدد البنود والتكلفة المقدّرة
- ✅ استرجاع النتائج المحفوظة

### ماذا لا يعمل
- ❌ حصر PDF (يتطلب `pdftotext` على الخادم)
- ❌ BIM/IFC/GLB (يتطلب تخزين ملفات)
- ❌ إدارة الطبقات اليدوية (POST/PATCH/DELETE) — تُرجع `DEMO_LIMIT`
- ❌ المساعد الذكي — يُرجع `DEMO_LIMIT`

### الاختبار
7/7 اختبار end-to-end ناجح:
1. إنشاء مشروع → 201 ✓
2. boq-imports مع null projectId → 400 NO_PROJECT (رسالة واضحة بالعربي/الإنجليزي) ✓
3. boq-imports مع CSV صحيح → 201 imported=3 ✓
4. عرض BOQ → 200 3 بنود ✓
5. ملخص المشروع: boqItems=3, cost=39925 ✓
6. إضافة بند يدوي → 201 amount=11520 ✓
7. DXF takeoff ما زال يعمل → 201 ✓

---

## 8) صور شبيهة بـ neubuild.ai (12 صورة)

تم البحث عن صور حقيقية من الويب (royalty-free) عبر ZAI image-search،
بواقع 4 فئات × 3 صور = 12 صورة:

| الفئة | الملفات | الاستخدام |
|-------|---------|----------|
| موقع بناء (hero) | hero-construction-site-1/2/3.jpg | غلاف المشروع، البانر الرئيسي |
| عامل بتقنية AR | worker-ar-tech-1/2/3.jpg | بطاقات الأنشطة، معرض الصور |
| نموذج BIM على شاشة | bim-model-screen-1/2/3.jpg | قسم BIM، معاينة النماذج |
| لوحة Gantt و KPI | dashboard-gantt-1/2/3.png | قسم البرنامج الزمني، نظرة عامة |

### آلية الحقن
بدلاً من تعديل `index.html` يدوياً، الـ `mmc-ai-bundle.js` يحوي دالة `applyImages()`
تعمل على `DOMContentLoaded` و تستبدل `src` لعناصر `<img>` الموجودة في الصفحة
بواسطة selectors CSS مثل `#projectCover` و `.activity-card img`.

الصور محفوظة في `/assets/` و يتم خدمتها من `serve_preview.py` بمسار مطلق.

---

## كيفية التطبيق

انسخ الملفات إلى مشروع v13 لديك، أو استخدم الوضع التجريبي:

```bash
cd mmc-ai-v13-fixed
python3 serve_preview.py
# افتح: http://localhost:8807/mmc-ai/workspace
```

### إعادة تعيين البيانات
```js
// في console المتصفح (F12):
localStorage.removeItem('mmc-ai-demo-v2'); location.reload();
```
