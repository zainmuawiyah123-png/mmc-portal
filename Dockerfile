FROM node:20-bookworm-slim

# أدوات بناء better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# تثبيت التبعيات أولاً (طبقة كاش أفضل)
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# باقي المشروع (واجهات + كود)
COPY . .

# تأكد أن واجهات البوابة موجودة داخل الصورة (يمنع 404 الصامت على Render)
RUN test -f webpages/technical-proposal-kit_v5/portal/pt-9f3c7a1e5b2d/login.html \
 && test -f webpages/technical-proposal-kit_v5/procurement/index.html \
 && test -f webpages/technical-proposal-kit_v5/bid/index.html \
 || (echo "FATAL: MISSING WEB UI FILES under webpages/technical-proposal-kit_v5" && find webpages -maxdepth 3 -type d 2>/dev/null; exit 1)


ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    COOKIE_SECURE=true \
    DB_PATH=/data/portal.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups \
    STORAGE_DRIVER=local \
    WEB_ROOT=/app/webpages/technical-proposal-kit_v5 \
    SCHEDULER_ENABLED=false

VOLUME /data
EXPOSE 4000

WORKDIR /app/server

# ترحيل القاعدة + إنشاء حساب المدير إن لم يوجد + تشغيل الخادم
CMD ["sh", "-c", "\
  mkdir -p /data/uploads /data/backups && \
  node src/migrate.js && \
  node scripts/setup-admin.js && \
  node src/index.js \
"]
