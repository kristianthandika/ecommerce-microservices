# =============================================================================
# frontend — POLA BERBEDA dari service backend: React di-build jadi static file
# lalu DISAJIKAN nginx (BUKAN Node runtime). BUILD CONTEXT = ROOT REPO.
# `docker build -f frontend/Dockerfile .`
# =============================================================================

# ---- build: compile TS + bundle Vite jadi /dist ----
FROM node:24-alpine AS build
WORKDIR /app

# Semua manifest workspace (npm workspaces butuh ada); install HANYA subtree
# frontend + root → tidak menarik dep backend (mis. native bcrypt).
COPY package.json package-lock.json ./
COPY packages/storage/package.json packages/storage/
COPY packages/logger/package.json packages/logger/
COPY packages/resilient-http-client/package.json packages/resilient-http-client/
COPY services/auth-service/package.json services/auth-service/
COPY services/product-service/package.json services/product-service/
COPY services/order-service/package.json services/order-service/
COPY services/gateway/package.json services/gateway/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund --workspace=frontend --include-workspace-root

# VITE_API_BASE_URL di-BAKE SAAT BUILD (bukan runtime nginx). Ini URL yang
# diakses BROWSER user (jalan di host, di luar Docker network) → default
# localhost:8080, bukan http://gateway:8080. Lihat m4.1/m4.4.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY frontend ./frontend
RUN npm run build --workspace=frontend

# ---- runtime: nginx menyajikan static file ----
FROM nginx:stable-alpine AS runtime
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/site.conf /etc/nginx/site.conf
RUN sed -i -E 's@pid[[:space:]]+[^;]+;@pid /tmp/nginx.pid;@; /^user[[:space:]]/d' /etc/nginx/nginx.conf && chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
