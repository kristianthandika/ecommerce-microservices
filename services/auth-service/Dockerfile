# =============================================================================
# auth-service — multi-stage, non-root, all-Alpine.
#
# BUILD CONTEXT WAJIB = ROOT REPO (monorepo npm workspaces), bukan folder
# service. Contoh: `docker build -f services/auth-service/Dockerfile .`
#
# Semua stage pakai Alpine (musl) yang SAMA supaya native binding `bcrypt`
# yang dikompilasi di stage build kompatibel saat runtime. (Mengcompile di
# glibc lalu menjalankan di Alpine/musl akan gagal load — itu sebabnya TIDAK
# memakai node:24 biasa untuk build + alpine untuk runtime.)
# =============================================================================

# ---- build: install semua dep (butuh toolchain untuk compile bcrypt di musl),
#      lalu build shared packages (tsc), lalu prune dev deps ----
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Copy SEMUA manifest workspace dulu (cache-friendly) — npm workspaces butuh
# seluruh manifest yang direferensikan lockfile.
COPY package.json package-lock.json ./
COPY packages/storage/package.json packages/storage/
COPY packages/logger/package.json packages/logger/
COPY packages/resilient-http-client/package.json packages/resilient-http-client/
COPY services/auth-service/package.json services/auth-service/
COPY services/product-service/package.json services/product-service/
COPY services/order-service/package.json services/order-service/
COPY services/gateway/package.json services/gateway/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund

# Build shared packages ke dist/ (dikonsumsi service sebagai library).
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build:packages

# Buang dev deps (typescript, dsb) — bcrypt yang sudah dikompilasi tetap ada.
RUN npm prune --omit=dev --no-audit --no-fund && mkdir -p /app/services/auth-service/node_modules

# ---- runtime: alpine ramping, non-root, jalankan .ts via type stripping Node 24 ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY scripts/backup.ts ./scripts/backup.ts
COPY services/auth-service ./services/auth-service
COPY --from=build /app/services/auth-service/node_modules ./services/auth-service/node_modules

# Folder keys/ ditulis saat runtime (generate keypair) & di-mount sbg volume
# (m4.4). Volume baru dimiliki root, proses jalan sebagai `node` → set
# kepemilikan SEBELUM switch USER, kalau tidak EACCES saat menulis keypair.
RUN mkdir -p /app/services/auth-service/keys && chown -R node:node /app/services/auth-service/keys

RUN mkdir -p /app/data && chown node:node /app/data
USER node
WORKDIR /app/services/auth-service
EXPOSE 3001
CMD ["node", "src/index.ts"]
