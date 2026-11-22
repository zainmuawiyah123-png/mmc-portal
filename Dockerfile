FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pil make g++ poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY . .

# Gate staging releases on the BOQ parser syntax and real CSV/XLSX regression tests.
RUN cd server && node --check src/lib/mmc-ai/boq-import.js && node --check src/routes/mmc-ai-primavera.js && node --check src/routes/mmc-ai-documents.js && node --check src/lib/mmc-ai/ocr-engine.js && node --check src/lib/mmc-ai/pdf-drawing-text-intelligence.js && node --check src/lib/mmc-ai/pdf-evidence-correlation.js && node --test tests/mmc-ai-boq-import.test.js tests/mmc-ai-ocr-engine.test.js tests/mmc-ai-pdf-drawing-text-intelligence.test.js tests/mmc-ai-drawing-reader-ui.test.js tests/mmc-ai-pdf-page-evidence.test.js tests/mmc-ai-pdf-vector-geometry.test.js tests/mmc-ai-pdf-vector-extract.test.js tests/mmc-ai-evidence-correlation.test.js tests/mmc-ai-pdf-quantity-candidates.test.js

# يوقف البناء بدل أن يصدر 404 صامتاً إن غابت واجهات البوابات عن الصورة
RUN test -f webpages/technical-proposal-kit_v5/portal/pt-9f3c7a1e5b2d/login.html \
 && test -f webpages/technical-proposal-kit_v5/procurement/index.html \
 && test -f webpages/technical-proposal-kit_v5/bid/index.html \
 && test -f webpages/technical-proposal-kit_v5/admin/index.html \
 && test -f webpages/technical-proposal-kit_v5/org/index.html \
 || (echo "FATAL: MISSING WEB UI FILES under webpages/technical-proposal-kit_v5" && find webpages -maxdepth 3 -type d; exit 1)

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    WEB_ROOT=/app/webpages/technical-proposal-kit_v5 \
    COOKIE_SECURE=true \
    DB_PATH=/data/portal.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups
VOLUME /data
EXPOSE 4000
WORKDIR /app/server
# ترحيل القاعدة، ثم إنشاء حساب المدير إن عُيّنت ADMIN_EMAIL/ADMIN_PASSWORD، ثم الخادم
CMD ["sh", "-c", "mkdir -p /data/uploads /data/backups && node src/migrate.js && node scripts/setup-admin.js && node src/index.js"]
