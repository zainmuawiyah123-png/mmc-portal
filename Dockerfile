FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY . .

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
