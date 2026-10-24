FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY . .
ENV NODE_ENV=production \
    PORT=4000 \
    COOKIE_SECURE=true \
    DB_PATH=/data/portal.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups
VOLUME /data
EXPOSE 4000
WORKDIR /app/server
CMD ["sh", "-c", "mkdir -p /data/uploads /data/backups && node src/migrate.js && node src/index.js"]
