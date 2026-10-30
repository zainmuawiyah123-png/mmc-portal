#!/usr/bin/env bash
# ============================================================
# سيناريو شامل بنقاط API حقيقية — يوثّق كل خطوة ورمز الاستجابة
# التشغيل:  bash scripts/e2e.sh   (يحتاج خادماً على المنفذ 4100)
# ============================================================
set -u
BASE="${BASE:-http://127.0.0.1:4100}"
OUT="$(dirname "$0")/../test-results.txt"
J1=$(mktemp) ; J2=$(mktemp)
PASS=0 ; FAIL=0
E2E_EMAIL="e2e$(date +%s)@contractor.test"
E2E_PASS="Contractor#2026"

line(){ printf '%s\n' "$*" >> "$OUT"; }
section(){ line ""; line "══════════════════════════════════════════════════════════"; line " $*"; line "══════════════════════════════════════════════════════════"; }
check(){ # check <description> <actual> <expected>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); line "  ✅ $1  →  HTTP $2"; 
  else FAIL=$((FAIL+1)); line "  ❌ $1  →  HTTP $2 (المتوقع $3)"; fi
}
# يُشغّل طلباً؛ يطبع رمز الحالة ويضع الجسم في $BODY (ملف ثابت خارج الـ subshell)
BODY=/tmp/e2e-body.json
req(){ # req <jar> <method> <path> [json-body]
  local jar="$1" m="$2" p="$3" body="${4:-}" code
  if [ -n "$body" ]; then
    code=$(curl -s -o "$BODY" -w '%{http_code}' -b "$jar" -c "$jar" -X "$m" \
      -H 'Content-Type: application/json' -d "$body" "$BASE$p")
  else
    code=$(curl -s -o "$BODY" -w '%{http_code}' -b "$jar" -c "$jar" -X "$m" "$BASE$p")
  fi
  echo "$code"
}

: > "$OUT"
line "═══════════════════════════════════════════════════════════════════════"
line " نتائج اختبار التكامل الحقيقي — بوابة العروض الفنية (المرحلة الأولى)"
line " التاريخ: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
line " الخادم: $BASE"
line " طريقة التنفيذ: curl فعلي على خادم Express يعمل بقاعدة SQLite"
line "═══════════════════════════════════════════════════════════════════════"

# ---------- 1) صحة الخادم ----------
section "1) صحة الخادم"
code=$(curl -s -o /tmp/h.json -w '%{http_code}' "$BASE/api/health")
check "GET /api/health" "$code" "200"
line "     الاستجابة: $(cat /tmp/h.json)"

# ---------- 2) تسجيل مستخدم أول ----------
section "2) تسجيل مستخدم (Register)"
code=$(req "$J1" POST /api/auth/register "{\"name\":\"م. زين\",\"email\":\"$E2E_EMAIL\",\"password\":\"$E2E_PASS\",\"company\":\"مكتب المقاولات\"}")
check "POST /api/auth/register" "$code" "201"
line "     المستخدم: $(head -c 220 "$BODY")…"
UID_A=$(sed -n 's/.*"id":"\(usr_[^"]*\)".*/\1/p' "$BODY")
line "     معرّف المستخدم: $UID_A"

# ---------- 3) محاولة الوصول قبل الدخول ----------
section "3) الوصول بدون تسجيل دخول (يجب أن يُرفض)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tenders")
check "GET /api/tenders بلا كوكي" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/me")
check "GET /api/auth/me بلا كوكي" "$code" "401"

# ---------- 4) تسجيل الخروج ثم الدخول ----------
section "4) تسجيل الخروج ثم تسجيل الدخول"
code=$(req "$J1" POST /api/auth/logout); check "POST /api/auth/logout" "$code" "200"
code=$(req "$J1" GET /api/auth/me);     check "GET /api/auth/me بعد الخروج" "$code" "401"
code=$(req "$J1" POST /api/auth/login "{\"email\":\"$E2E_EMAIL\",\"password\":\"$E2E_PASS\"}")
check "POST /api/auth/login" "$code" "200"
code=$(req "$J1" POST /api/auth/login "{\"email\":\"$E2E_EMAIL\",\"password\":\"WRONG-PASS\"}")
check "دخول بكلمة مرور خاطئة" "$code" "401"

# ---------- 5) إنشاء عطاء ----------
section "5) إنشاء عطاء"
code=$(req "$J1" POST /api/tenders '{"name":"عمارة سكنية ٦ طوابق — اختبار E2E","authority":"أمانة عمان الكبرى","closing":"2026-12-15","notes":"نطاق كامل"}')
check "POST /api/tenders" "$code" "201"
TID=$(sed -n 's/.*"tender":{"id":"\(tnd_[^"]*\)".*/\1/p' "$BODY")
line "     معرّف العطاء: $TID"

# ---------- 6) رفع ملف ----------
section "6) رفع ملفات (multipart)"
printf '%%PDF-1.4\nE2E TEST DRAWING\n' > /tmp/e2e-plan.pdf
code=$(curl -s -o /tmp/up.json -w '%{http_code}' -b "$J1" -c "$J1" \
  -F "files=@/tmp/e2e-plan.pdf;filename=arch-plan.pdf;type=application/pdf" \
  -F "category=arch" "$BASE/api/tenders/$TID/files")
check "POST /api/tenders/:id/files (PDF)" "$code" "201"
FID=$(sed -n 's/.*"id":"\(fil_[^"]*\)".*/\1/p' /tmp/up.json)
line "     الملف: $(cat /tmp/up.json | head -c 200)…"
line "     معرّف الملف: $FID"

printf 'STRUCT-CONTENT\n' > /tmp/e2e-struct.pdf
code=$(curl -s -o /tmp/up2.json -w '%{http_code}' -b "$J1" -c "$J1" \
  -F "files=@/tmp/e2e-struct.pdf;filename=struct-slab.pdf;type=application/pdf" \
  -F "category=struct" "$BASE/api/tenders/$TID/files")
check "رفع ملف ثانٍ (إنشائي)" "$code" "201"

printf 'MZ\x90\x00' > /tmp/e2e-bad.exe
code=$(curl -s -o /tmp/bad.json -w '%{http_code}' -b "$J1" -c "$J1" \
  -F "files=@/tmp/e2e-bad.exe;filename=malware.exe" "$BASE/api/tenders/$TID/files")
check "رفع ملف .exe (يجب رفضه)" "$code" "415"
line "     رسالة الرفض: $(cat /tmp/bad.json)"

# ---------- 7) عرض الملفات ----------
section "7) عرض ملفات العطاء"
code=$(req "$J1" GET "/api/tenders/$TID/files"); check "GET /api/tenders/:id/files" "$code" "200"
line "     $(head -c 260 "$BODY")…"
NFILES=$(grep -o '"id":"fil_' "$BODY" | wc -l | tr -d ' ')
line "     عدد الملفات المسترجعة: $NFILES"

# ---------- 8) تحميل محمي ----------
section "8) تحميل الملف (محمي بالملكية)"
code=$(curl -s -o /tmp/dl.bin -w '%{http_code}' -b "$J1" "$BASE/api/files/$FID/download")
check "GET /api/files/:id/download (المالك)" "$code" "200"
line "     أول سطر من المحتوى: $(head -1 /tmp/dl.bin)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files/$FID/download")
check "تحميل بلا جلسة" "$code" "401"

# ---------- 9) مستخدم ثانٍ — عزل الملكية ----------
section "9) مستخدم ثانٍ لا يستطيع الوصول (عزل الملكية)"
E2E2="e2e2$(date +%s)@contractor.test"
code=$(req "$J2" POST /api/auth/register "{\"name\":\"مستخدم ثانٍ\",\"email\":\"$E2E2\",\"password\":\"$E2E_PASS\"}")
check "تسجيل المستخدم الثاني" "$code" "201"
code=$(req "$J2" GET "/api/tenders/$TID");             check "قراءة عطاء المستخدم الأول" "$code" "404"
code=$(req "$J2" PATCH "/api/tenders/$TID" '{"name":"استوليت"}'); check "تعديل عطاء المستخدم الأول" "$code" "404"
code=$(req "$J2" DELETE "/api/tenders/$TID");          check "حذف عطاء المستخدم الأول" "$code" "404"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J2" "$BASE/api/files/$FID/download")
check "تحميل ملف المستخدم الأول" "$code" "404"
code=$(req "$J2" GET /api/tenders);                    check "قائمة عطاءات المستخدم الثاني (فارغة)" "$code" "200"
line "     عدد عطاءات المستخدم الثاني: $(sed -n 's/.*"count":\([0-9]*\).*/\1/p' "$BODY")"

# ---------- 10) حذف الملف ----------
section "10) حذف ملف"
code=$(req "$J1" DELETE "/api/files/$FID"); check "DELETE /api/files/:id (المالك)" "$code" "200"
line "     $(cat "$BODY")"
code=$(req "$J1" DELETE "/api/files/$FID"); check "حذف نفس الملف مرة أخرى" "$code" "404"
code=$(req "$J1" GET "/api/tenders/$TID/files"); check "عرض الملفات بعد الحذف" "$code" "200"
line "     $(head -c 200 "$BODY")…"

# ---------- 11) الطلبات ----------
section "11) الاستفسارات / طلبات التعديل"
code=$(req "$J1" POST "/api/tenders/$TID/requests" '{"text":"أرجو تعديل جدول الدفعات ليبدأ من 15%","kind":"change"}')
check "POST /api/tenders/:id/requests" "$code" "201"
code=$(req "$J1" GET "/api/tenders/$TID/requests"); check "GET الطلبات" "$code" "200"

# ---------- 12) الباقة والاستهلاك ----------
section "12) الباقة والاستهلاك وحدود الاشتراك"
code=$(req "$J1" GET /api/usage); check "GET /api/usage" "$code" "200"
line "     $(head -c 300 "$BODY")"
code=$(req "$J1" POST /api/tenders '{"name":"عطاء ثانٍ على الباقة المجانية"}')
check "عطاء ثانٍ على Free (يجب رفضه)" "$code" "402"
line "     $(head -c 240 "$BODY")"
code=$(req "$J1" POST /api/plan '{"planKey":"starter"}'); check "ترقية إلى starter" "$code" "200"
code=$(req "$J1" POST /api/tenders '{"name":"عطاء ثانٍ بعد الترقية"}'); check "عطاء ثانٍ بعد الترقية" "$code" "201"
code=$(req "$J1" POST /api/plan '{"planKey":"free"}'); check "رجوع لباقة أصغر (يجب رفضه)" "$code" "409"

# ---------- 13) التحقق من التشفير ----------
section "13) التحقق من تشفير كلمة المرور في قاعدة البيانات"
HASH=$(node -e "
const D=require('better-sqlite3');
const d=new D(process.env.DB_PATH || 'data/demo.db',{readonly:true});
const r=d.prepare('SELECT email,password_hash FROM users ORDER BY created_at LIMIT 1').get();
if(r) console.log(r.password_hash); d.close();
" 2>/dev/null)
line "  البريد: $E2E_EMAIL"
line "  القيمة المخزّنة: $HASH"
if echo "$HASH" | grep -qE '^\$2[aby]\$'; then
  PASS=$((PASS+1)); line "  ✅ القيمة bcrypt hash (بادئة \$2، الطول ${#HASH}) — ليست نصاً صريحاً"
else
  FAIL=$((FAIL+1)); line "  ❌ القيمة ليست bcrypt hash!"
fi
if echo "$HASH" | grep -qF "$E2E_PASS"; then
  FAIL=$((FAIL+1)); line "  ❌ كلمة المرور موجودة نصاً داخل القيمة!"
else
  PASS=$((PASS+1)); line "  ✅ كلمة المرور غير موجودة نصاً في القيمة المخزّنة"
fi

# ---------- 14) الخروج النهائي ----------
section "14) تسجيل الخروج وإنهاء الجلسة"
code=$(req "$J1" POST /api/auth/logout); check "POST /api/auth/logout" "$code" "200"
code=$(req "$J1" GET /api/tenders);     check "محاولة الوصول بعد الخروج" "$code" "401"

# ---------- الملخص ----------
section "الملخص"
TOTAL=$((PASS+FAIL))
line "  إجمالي الفحوصات: $TOTAL"
line "  ناجح: $PASS"
line "  فاشل: $FAIL"
line ""
if [ "$FAIL" -eq 0 ]; then
  line "  ══> النتيجة: نجحت جميع الفحوصات ($PASS/$TOTAL) ══<"
else
  line "  ══> النتيجة: $FAIL فحص/فحوصات فاشلة ══<"
fi
line ""
line "ملاحظة: قاعدة البيانات المستخدمة في هذا الاختبار هي data/demo.db داخل مجلد server/."
line "        التخزين على القرص في uploads_demo/."

cat "$OUT"
rm -f "$J1" "$J2"
[ "$FAIL" -eq 0 ]
