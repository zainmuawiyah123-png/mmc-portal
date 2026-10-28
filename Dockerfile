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

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    COOKIE_SECURE=true \
    DB_PATH=/data/portal.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups \
    STORAGE_DRIVER=local \
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
