# MMC BIM Studio — قراءة المخططات · الكميات · BIM

ملف واحد مكتفٍ بذاته (`MMC-BIM-Studio.html`) — لا خادم، لا تثبيت، لا إنترنت.
افتحه في أي متصفح حديث (Chrome / Edge / Firefox / Safari) وابدأ العمل.

A single self-contained file (`MMC-BIM-Studio.html`) — no server, no install, no
internet. Open it in any modern browser and start working.

---

## العربية

### ما هو

استوديو يعمل بالكامل داخل المتصفح: يقرأ مخططاً (DXF أو PDF)، يصنّف عناصره إلى
تخصصات، يحسب كميات بقواعد معلنة، ثم يبني نموذج BIM ويصدّره IFC4 وGLB.

**المبدأ الحاكم: لا تخمين.** كل كمية تُحسب من بُعد مرسوم أو من قيمة أدخلها
المهندس صراحةً. وكل عنصر يحمل افتراضاته داخله، وما لا يمكن قياسه يُدرج في
قائمة «لم يُنمذج» مع السبب — لا يُقدَّر ولا يُسقط بصمت.

### التشغيل

```
افتح MMC-BIM-Studio.html في المتصفح (نقر مزدوج يكفي)
```

لا حاجة لأي تثبيت. الملف يحمل داخله pdf.js ومحرّكات الحصر وBIM.

### الاستخدام

1. **ارفع المخطط** — اسحب ملف `.dxf` أو `.pdf` على منطقة الرفع.
2. **اقرأ** — اضغط «اقرأ المخطط». تظهر العناصر المقروءة والامتداد ووحدة الرسم.
   - **PDF**: أدخل مقياس الرسم (مثل `100` لـ 1:100) أو استخدم «معايرة بنقطتين».
     ملفات PDF لا تحمل أسماء طبقات، فتظهر **ألواناً** — عيّن لكل لون فئته.
3. **صنّف** — التصنيف تلقائي من أسماء الطبقات في DXF. عدّله من جدول الطبقات.
   الطبقات غير المصنّفة **لا تُحسب ولا تُنمذج**.
4. **أدخل القيم** — ارتفاع الجدار، سماكة البلاطة، عمق الأساس، ولقواعد حديد التسليح
   أدخل قطر السيخ ونسبة الهالك/الوصلات إن كانت معتمدة… الحقول مملوءة
   بالقيم الافتراضية للمحرّك، وكل قيمة لم تغيّرها تُعلَن كافتراض في النموذج.
5. **احسب الكميات** — جدول لكل فئة: الحالة، الكمية المقترحة، الصيغة، الطبقات.
   حديد التسليح يعرض الطول المرسوم، والطول بعد الهالك/الوصلات، والوزن بالكيلوغرام
   وفق العلاقة `kg/m = d²/162` عند إدخال قطر السيخ؛ لا يُستنتج القطر من الرسم.
6. **ولّد BIM** — معاينة ثلاثية الأبعاد + تنزيل IFC4 / GLB / JSON / CSV.
7. **«أظهر في النموذج»** — على أي صف في جدول النموذج، يعزل فئته في العارض.

### التخصصات المدعومة

| التخصص | أمثلة الفئات |
|---|---|
| إنشائي | أساسات، أعمدة، جسور، بلاطات، جدران قص، خوازيق، حديد تسليح |
| معماري | جدران، أرضيات، أبواب، شبابيك، سلالم، تشطيبات، أسطح، درابزين |
| كهربائي | إنارة، مقابس، لوحات، كابلات ومواسير، إنذار حريق، كاميرات، تأريض |
| ميكانيكي | مجاري هواء، فتحات تكييف، معدات، مراوح، مبردات، مضخات، صمامات |
| صحي | تغذية مياه، صرف، أدوات صحية |
| مدني / مناظر | أرصفة، أسوار، رصف، مواقف، مسطحات خضراء |

### المخرجات

- **IFC4** — يفتح في Revit وArchiCAD وNavisworks وBIMvision وIfcOpenShell.
  يحمل `IfcOpeningElement` حقيقياً لكل باب ونافذة، ومجموعة خصائص `MMC_AI`
  لكل عنصر (الطبقة، التخصص، الفئة، الافتراضات، صفحة المصدر).
- **GLB** — يفتح في أي عارض glTF (Blender، three.js، Windows 3D Viewer).
- **JSON** — النموذج كاملاً مع هندسة كل عنصر وكمياته وافتراضاته.
- **CSV** — بنود الكميات جاهزة لـ Excel.

### تطوير التسليح وBIM

يقرأ محرك PDF الآن ملاحظات التسليح الشائعة مثل `Y16-200 C/C` و`Y16 @ 200`
و`2Y16` و`6Y18` من نصوص PDF والـ annotations التي تنتجها AutoCAD، ويعرض القطر
والتباعد والعدد كملاحظات تحتاج مراجعة. عند وجود قطر مهيمن واضح يمكن استخدامه
تلقائياً في الحصر وتوليد BIM؛ أما التفاصيل ذات أقطار متعددة فتظل بحاجة إلى ربط
الملاحظة بالعنصر من المهندس.

يولّد BIM الآن قضبان التسليح كعناصر خطية مرئية بلون مستقل، ويضعها في ملخص النموذج
وجدول BOQ مع الطول والوزن وقطر السيخ في خصائص JSON/IFC. عند وجود موضع الملاحظة
في PDF يبحث البرنامج عن أقرب خط متجهي في الصفحة نفسها ويضيفه تلقائياً كمرشح
تسليح بطبقة `PDF-REBAR-AUTO`. يظهر في التقرير هل تم الربط والمسافة بين الملاحظة
والخط. عند غياب موضع الملاحظة أو عدم وجود خط قريب، تُعرض الملاحظة فقط ولا يُخترع
سيخ هندسي.

الربط التلقائي تقديري وموسوم `needs_review`: يجب مراجعة الاتجاه والطول والمنطقة
والتباعد وربط الملاحظة بالعنصر الإنشائي قبل اعتماد الوزن أو التصدير التعاقدي.

### حدود يجب معرفتها

- **هندسة المنشورات المستطيلة فقط** — وهو ما يدعمه مخطط ثنائي الأبعاد بصدق.
  المنحنيات والأشكال المائلة تُبلَّغ عنها ولا تُقرَّب.
- **الارتفاعات والسماكات ليست في المسقط** — تأتي من لوحة المعاملات، وتُعلَن
  كافتراضات. النموذج أداة تنسيق، **ويحتاج مراجعة مهندس قبل الاستخدام التعاقدي**.
- **الفتحات تُخصم من مساحة الجدران** بالقياس المرسوم (عرض الورقة/النافذة)،
  لا بالمقاس النموذجي.
- **الجدران المرسومة كمقاطع متعددة تُدمج** تلقائياً في جدار واحد (تفاوت 2 سم).
- **PDF أحادي اللون** يحتاج تعييناً يدوياً لكل لون — لا يمكن تمييز التخصصات
  من لون واحد.
- **الكميات كلها `needs_review`** حتى يعتمدها مهندس.

### قراءة DXF — ما يُقبل وما يُرفض

المحرّك يقرأ **ASCII DXF** من R12 حتى R2018، ومن أي برنامج (AutoCAD، Revit export، QCAD/LibreCAD، BricsCAD).

**يُقرأ ويُقاس:** `LINE` · `LWPOLYLINE` · `POLYLINE` · `CIRCLE` · `ARC` · `INSERT` (بما فيها المصفوفات MINSERT والكتل المتداخلة والمرآة والمقياس غير المتساوي).

**يُبلَّغ عنه ولا يُقاس** (يظهر في شريط «عناصر غير مدعومة لم تُقس»): `SPLINE` · `ELLIPSE` · `HATCH` · `3D SOLID` · `XREF` غير مربوط · أي كتلة بلا تعريف `BLOCK` في الملف.

**الترميز:** يُقرأ `$DWGCODEPAGE` من الـHEADER ويُفكّ به النص — فملفات `ANSI_1256` العربية تُقرأ بأسماء طبقاتها الصحيحة. وإن كان الملف UTF-8 فعلياً مع codepage قديم، يُرجَّح UTF-8 (لأن البايتات صحيحة).

**الوحدات:** تُقرأ من `$INSUNITS`. وإن كانت `0` أو غائبة (شائع في R12) تظهر رسالة تطلب اختيار الوحدة من القائمة — لا فشل صامت.

**DXF الثنائي (Binary DXF)** يُكشف من بصمته في أول بايتات الملف وتظهر رسالة تشرح كيف تحفظه كـASCII DXF.

**التسامح:** نهايات أسطر LF/CRLF/CR، أكواد مجموعات مُبطّنة بمسافات، قيم فارغة مشروعة (سطر فارغ بعد كود)، إحداثي Y قبل X، وغياب `EOF` — كلها تُقرأ.

**حدود الحجم:** 20,000 مثيل كتلة كحد أقصى بعد التوسيع (حماية من الانفجار).

### الاختبار

```
python3 test/make_fixtures.py            # يبني مخططات DXF للاختبار
python3 test/make_pdf.py                 # يبني مخطط PDF
python3 test/dxf_reader_regression.py    # 15 اختبار انحدار لقارئ DXF
python3 test/final_check.py              # المسار الكامل + كل التصديرات
```

`dxf_reader_regression.py` يستخرج المحرّك من الـHTML نفسه ويشغّله في Node، فيختبر الكود الذي يُشحن فعلاً. كل اختبار فيه يثبّت عطلاً أُعيد إنتاجه في متصفح حقيقي قبل إصلاحه.

يتطلب `playwright` و`ifcopenshell` و`gltf-validator` للتحقق الخارجي.

---

## English

### What it is

A fully in-browser studio: reads a drawing (DXF or PDF), classifies its elements
into disciplines, computes quantities with declared rules, then builds a BIM
model and exports IFC4 and GLB.

**Governing principle: no guessing.** Every quantity comes from a drawn dimension
or a value the engineer entered explicitly. Every element carries its own
assumptions, and anything that cannot be measured is listed under "not modelled"
with the reason — never estimated, never silently dropped.

### Running

```
Open MMC-BIM-Studio.html in a browser (double-click is enough)
```

No install. The file embeds pdf.js plus the takeoff and BIM engines.

### Using it

1. **Upload** — drop a `.dxf` or `.pdf` on the drop zone.
2. **Read** — press "Read drawing". You get the element count, extent and drawing unit.
   - **PDF**: enter the drawing scale (e.g. `100` for 1:100) or use two-point
     calibration. PDFs carry no layer names, so elements appear as **colours** —
     assign a category to each colour.
3. **Classify** — automatic from layer names for DXF. Override in the layer table.
   Unclassified layers are **neither measured nor modelled**.
4. **Enter values** — wall height, slab thickness, footing depth, and for
   reinforcement enter bar diameter and an explicit laps/waste allowance… Fields are
   pre-filled with engine defaults; any value you leave unchanged is declared as
   an assumption in the model.
5. **Compute quantities** — a table per category: status, proposed quantity,
   formula, source layers.
   Reinforcement reports drawn length, length including the explicit allowance, and
   weight in kilograms using `kg/m = d²/162` when a bar diameter is entered; diameter
   is never inferred from plan linework.
6. **Generate BIM** — 3D preview plus IFC4 / GLB / JSON / CSV downloads.
7. **"Show in model"** — on any model-table row, isolates that category in the viewer.

### Supported disciplines

| Discipline | Example categories |
|---|---|
| Structural | foundations, columns, beams, slabs, shear walls, piles, rebar |
| Architectural | walls, floors, doors, windows, stairs, finishes, roof, handrails |
| Electrical | lighting, outlets, panels, cables/conduits, fire alarm, CCTV, earthing |
| Mechanical | ducts, air terminals, equipment, fans, chillers, pumps, valves |
| Plumbing | water supply, drainage, sanitary fixtures |
| Civil / landscape | curbs, fencing, paving, parking, lawn |

### Outputs

- **IFC4** — opens in Revit, ArchiCAD, Navisworks, BIMvision, IfcOpenShell.
  Carries a real `IfcOpeningElement` per door and window, and an `MMC_AI`
  property set on every element (layer, discipline, category, assumptions,
  source page).
- **GLB** — opens in any glTF viewer (Blender, three.js, Windows 3D Viewer).
- **JSON** — the full model with each element's geometry, quantities and assumptions.
- **CSV** — quantity lines ready for Excel.

### Known limits

- **Rectangular prism geometry only** — which is what a 2D plan honestly supports.
  Curves and skewed shapes are reported, not approximated.
- **Heights and thicknesses are not in a plan** — they come from the parameter
  panel and are declared as assumptions. The model is a coordination aid and
  **needs engineer review before contractual use**.
- **Openings are deducted from wall area** at the drawn width (leaf / window
  width), not at a typical size.
- **Walls drawn as many segments are merged** into one wall automatically (2 cm tolerance).
- **A single-colour PDF** needs manual colour assignment — disciplines cannot be
  told apart from one colour.
- **All quantities are `needs_review`** until an engineer approves them.

### Reading DXF — what is accepted and what is refused

The engine reads **ASCII DXF** from R12 through R2018, from any writer (AutoCAD, Revit export, QCAD/LibreCAD, BricsCAD).

**Read and measured:** `LINE` · `LWPOLYLINE` · `POLYLINE` · `CIRCLE` · `ARC` · `INSERT` (including MINSERT arrays, nested blocks, mirrored and non-uniformly scaled inserts).

**Reported, not measured** (shown in the "unsupported elements not measured" bar): `SPLINE` · `ELLIPSE` · `HATCH` · `3D SOLID` · unbound `XREF` · any block with no `BLOCK` definition in the file.

**Encoding:** `$DWGCODEPAGE` is read from the HEADER and used to decode text, so Arabic `ANSI_1256` drawings keep their real layer names. If the bytes are genuinely valid UTF-8 while the codepage is stale, UTF-8 wins (the bytes are the truth).

**Units:** read from `$INSUNITS`. When it is `0` or absent (common in R12) the page asks you to pick the unit from the list — never a silent failure.

**Binary DXF** is detected from its byte sentinel and explained, with the steps to re-save it as ASCII DXF.

**Tolerance:** LF/CRLF/CR line endings, space-padded group codes, legitimate empty values (a blank line after a code), Y-before-X vertices, and a missing `EOF` all parse.

**Size limit:** 20,000 block instances after expansion (guards against explosion).

### Testing

```
python3 test/make_fixtures.py            # builds DXF test drawings
python3 test/make_pdf.py                 # builds a PDF test drawing
python3 test/dxf_reader_regression.py    # 15 DXF reader regression tests
python3 test/final_check.py              # full path + every export
```

`dxf_reader_regression.py` extracts the engine from the HTML itself and drives it in Node, so it tests the code that actually ships. Each test pins a defect that was reproduced in a real browser before being fixed.

Requires `playwright`, `ifcopenshell` and `gltf-validator` for external validation.

---

## ما تغيّر في هذه النسخة / What changed in this version

### أعطال أُصلحت / Bugs fixed

| # | العطل | السبب | الإصلاح |
|---|---|---|---|
| 1 | **44 فئة بلا قاعدة حصر** — أي مخطط يحتويها كان يُبلّغ «No measurement rule registered» ولا يُنتج كمية | `CATEGORY_RULES` تعرّف 71 فئة، و`RULES` تعرّف 27 فقط | أضفت 44 قاعدة عبر ثلاث دوال مصنع (`countRule` / `lengthRule` / `areaRule`) |
| 2 | **الأبواب تُعدّ مرتين** — 8 أبواب ظهرت 16 | الباب يُرسم كخط ورقة + قوس فتح = كيانان | `distinctPositions()` تجمع أجزاء الرمز الواحد بالموضع |
| 3 | **الفتحات لا تُخصم من الجدران** — «0 openings deducted» | مقاسات الأبواب/النوافذ لم تكن تُمرَّر إلى قاعدة الجدران | تمرير `doorWidthM`/`windowWidthM`… إلى `buildWallOpenings` |
| 4 | **مساحة الزجاج مبالغ فيها** — نافذة 1.6 م قُرئت 5.2 م | محيط المستطيل استُخدم كعرض فتحة | `measuredOpeningWidth()` تأخذ الضلع الطويل للعارضة |
| 5 | **لوحة الافتراضات فارغة** — «افتراضات مطبَّقة: .» | التعبئة المسبقة للحقول جعلت `parametersSetByUser` يظن كل قيمة مُدخلة | المقارنة مع `DEFAULTS` بدل تتبّع التغيير |
| 6 | **التجهيزات الصحية لا تُنمذج** — «category has no geometric model rule» | لها قاعدة حصر لكنها غائبة من `DEVICES`/`SPEC` | أضفت `sanitary_fixtures` و`valves` |
| 7 | **لا ربط بين جدول النموذج والعارض** | لم تكن الميزة موجودة | زر «أظهر في نموذج» + `viewer.setFocus()` |
| 8 | **تفتّت الجدران** — مخطط PDF أنتج 4,164 جداراً لعدد قليل | كل خط قصير صار منشوراً مستقلاً | `mergeCollinearWalls()` تدمج المقاطع المتصلة على نفس المحور |
| 9 | **`IfcOpeningElement` غائب** — الفتحات مقصوصة هندسياً فقط | لم يكن الكاتب يُصدر عناصر فتح | إصدار `IfcOpeningElement` + `IfcRelVoidsElement` لكل فتحة |
| 10 | **`lengthM` مفقود من الجدران** بعد الدمج | `piece()` لم تمرّر الطول | تمرير `lengthM` في كل قطعة |

### تحسينات / Improvements

- **18 فتحة حقيقية** في IFC بدل صفر.
- **`wallsMerged`** يُبلَّغ في النموذج ليعرف المستخدم كم مقطعاً دُمج.
- **أزرار «أظهر في نموذج»** في جدول النموذج (18 زراً، إبراز وإلغاء).
- **أسلوب `button.mini`** للجداول الكثيفة.
- **تعليقات توضيحية** عند كل إصلاح تشرح السبب لا الفعل فقط.

### التحقق / Verification

| الفحص | النتيجة |
|---|---|
| تحميل الصفحة | **صفر أخطاء** JavaScript، صفر أخطاء كونسول |
| DXF Rev A | 137 صفاً ← **164 عنصر BIM**، 5 تخصصات، 20 فتحة مخصومة |
| DXF Rev B | 153 صفاً ← **176 عنصر BIM**، 5 تخصصات |
| PDF | 125 عنصراً مقروءاً، مقياس 1:100، تعيين ألوان يدوي يعمل |
| IFC Rev A | `IFC4` · 164 منتجاً · **18 `IfcOpeningElement`** · 18 `IfcRelVoidsElement` · 164 pset |
| IFC Rev B | `IFC4` · 176 منتجاً · 18 فتحة · 176 pset |
| GLB Rev A/B | **gltf-validator: 0 أخطاء، 0 تحذيرات** |
| الجوال 390px | فائض أفقي = **0** |
| «أظهر في النموذج» | 18 زراً، إبراز يعمل، إلغاء يعمل |

---

## إصلاح قارئ DXF / DXF reader fixes

المستخدم أبلغ أن الملف «لا يقرأ DXF». أُعيد إنتاج المشكلة في متصفح حقيقي برفع 45 ملف DXF من واجهة الرفع نفسها، ووُجد أن الخادم والمحرّك سليمان — العطل في **طبقة القراءة والتحليل**، وستة أسباب مستقلة:

| # | العطل | السبب الدقيق | الإصلاح |
|---|---|---|---|
| 1 | **ملفات AutoCAD/Revit/QCAD حقيقية تُرفض** بـ«Malformed DXF group code» | `parsePairs` كانت **تحذف الأسطر الفارغة**. والسطر الفارغ في DXF قيمة فارغة مشروعة (مثل `$DIMBLK` بلا قيمة) — فحذفه يُزيح كل الأسطر التالية ويختل الاقتران | حذف الأسطر الفارغة **قبل** الاقتران فقط، مع الحفاظ على القيمة الفارغة كقيمة |
| 2 | **DXF الثنائي** يُقرأ كنص فيتحوّل إلى رموز مشوّهة | `readAsText` بلا فحص للبصمة الثنائية | قراءة `ArrayBuffer` أولاً، وكشف `AutoCAD Binary DXF\r\n\x1a\x00` من البايتات، ورسالة عربية تشرح كيف يُحفظ كـASCII |
| 3 | **أسماء الطبقات العربية مشوّهة** في ملفات `ANSI_1256` | ترميز UTF-8 ثابت، وتجاهل `$DWGCODEPAGE` | قراءة `$DWGCODEPAGE` من الـHEADER وفكّ النص بالترميز المطابق (cp1256 وأخواتها)، مع ترجيح UTF-8 إن كانت البايتات UTF-8 صحيحة فعلاً |
| 4 | **MINSERT والكتل المتداخلة والمرآة والمقياس غير المتساوي** تُسقَط بصمت (0 عنصر) | `expandBlockInserts` كانت ترفض `columns!==1`، و`INSERT` داخل كتلة، و`sx<=0`، و`|sx-sy|>1e-9` | توسيع المصفوفات (70/71/44/45)، والتوسيع المتداخل حتى عمق 8، والمرآة (قلب الـbulge وعكس قوس ARC)، والمقياس غير المتساوي |
| 5 | **INSUNITS=0 أو غائب** (R12، ملفات unitless) → فشل بلا إرشاد | `UNIT_TO_METRE[0]=null` يرمي استثناءً عاماً | رسالة `UNITS_UNDEFINED` تشرح السبب وتطلب اختيار الوحدة من القائمة |
| 6 | **نهايات أسطر CR فقط، أكواد مُبطّنة، Y قبل X، غياب EOF** | تقسيم على `/\r?\n/` فقط، وافتراض ترتيب X ثم Y | تطبيع `\r\n?`، تقليم الأكواد، وجمع إحداثيات الرأس بالموضع لا بالترتيب |

**وأُضيف:** كل فشل يظهر الآن برسالة عربية في `#readReport` — لا فشل صامت. وملف «صفر عنصر» يعرض قائمة الأسباب المحتملة (XREF غير مربوط، كتل بلا تعريف، عناصر غير مدعومة) مع عدد كل نوع.

**التحقق:** 45 ملف DXF (R12/R2000/R2010/R2018، ثنائي، Revit، QCAD، عربي cp1256/UTF-8/codepage قديم، MINSERT، متداخل، مرآة، مقياس غير متساوٍ، SPLINE، XREF، poly3d، 20,000 عنصر، CR-only، مُبطّن، Y-قبل-X، بلا EOF) — **كلها إما كميات صحيحة أو رسالة عربية واضحة**، وصفر أخطاء صفحة. و15 اختبار انحدار دائم في `test/dxf_reader_regression.py`.

---

## DXF reader fixes (English)

The user reported the file "does not read DXF". Reproduced in a real browser by uploading 45 DXF files through the actual upload control: the server and kernel were fine — the defect was in the **read/parse layer**, with six independent causes:

1. **Real AutoCAD/Revit/QCAD files rejected** with "Malformed DXF group code" — `parsePairs` dropped blank lines, but a blank line is a legitimate DXF **empty value** (`$DIMBLK` with no value). Dropping it shifted every following line and broke the pairing. Fixed by dropping blanks only before pairing, keeping the empty value.
2. **Binary DXF** parsed as text into mojibake — now read as `ArrayBuffer`, detected from the `AutoCAD Binary DXF\r\n\x1a\x00` sentinel, with an Arabic message explaining how to re-save as ASCII DXF.
3. **Arabic layer names mangled** in `ANSI_1256` files — hardcoded UTF-8, `$DWGCODEPAGE` ignored. Now the codepage is read from the HEADER and used to decode (cp1256 and friends), with UTF-8 winning when the bytes are genuinely valid UTF-8.
4. **MINSERT, nested blocks, mirrored and non-uniformly scaled inserts silently dropped** (0 elements) — now arrays (70/71/44/45) expand, nesting recurses to depth 8, mirroring flips the bulge and reverses ARC sweeps, and non-uniform scale is applied per axis.
5. **INSUNITS=0 or absent** (R12, unitless) failed with no guidance — now a `UNITS_UNDEFINED` message explains the cause and asks for the unit.
6. **CR-only line endings, padded group codes, Y-before-X, missing EOF** — normalised and parsed by position rather than assumed order.

**Also added:** every failure now surfaces an Arabic message in `#readReport` — never silent. A zero-element result lists the likely causes (unbound XREF, blocks with no definition, unsupported entity types) with a count per type.

**Verified:** 45 DXF files (R12/R2000/R2010/R2018, binary, Revit, QCAD, Arabic cp1256/UTF-8/stale codepage, MINSERT, nested, mirrored, non-uniform, SPLINE, XREF, poly3d, 20,000 elements, CR-only, padded, Y-before-X, no EOF) — **every one either yields correct quantities or a clear Arabic message**, with zero page errors. 15 permanent regression tests in `test/dxf_reader_regression.py`.
