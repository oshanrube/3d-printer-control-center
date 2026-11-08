# ---------- Frontend build ----------
FROM node:20-bookworm-slim AS frontend
WORKDIR /fe
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Backend build (TS -> JS, native deps) ----------
FROM node:20-bookworm-slim AS backend
WORKDIR /be
COPY backend/package.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build

# ---------- Runtime ----------
FROM node:20-bookworm-slim
WORKDIR /app
# Chromium is the WebRTC decode engine for K2/newer-K1C cameras (libpeer H264/DTLS).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8082 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/frontend \
    CHROMIUM_PATH=/usr/bin/chromium
COPY --from=backend /be/node_modules ./node_modules
COPY --from=backend /be/dist ./dist
COPY --from=backend /be/package.json ./package.json
COPY --from=frontend /fe/dist ./frontend
RUN mkdir -p /data
EXPOSE 8082
CMD ["node", "dist/index.js"]
