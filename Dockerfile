#
# Plattform-Image: Node-API (server/) + gebaute Oberflächen (platform/dist, API-Modus).
# Die API liefert die Seiten selbst aus (STATIC_DIR, eigene CSP) – siehe docs/betrieb.md 7.2.
# Betrieb mit deploy/docker-compose.yml (deploy/README.md). Keine Geheimnisse im Image.
#
#   docker build -t stunden-app:test .
#
# Node-Version wie CI (.github/workflows/ci.yml: Node 22). Basis-Image mit Digest gepinnt;
# Aktualisierung über Dependabot (package-ecosystem docker).
ARG NODE_IMAGE=node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

# ---------------------------------------------------------------- 1. Frontend bauen
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY platform ./platform
# "api" = echte Anmeldung gegen die eigene API. "demo" nur für reine Vorschau-Images.
ARG VITE_DATA_MODE=api
ENV VITE_DATA_MODE=${VITE_DATA_MODE}
RUN npx vite build --config platform/vite.config.ts

# ---------------------------------------------------------------- 2. Laufzeit-Abhängigkeiten (nur pg)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---------------------------------------------------------------- 3. Laufzeit
FROM ${NODE_IMAGE} AS runtime
# Commit des Builds für den Super-Admin-„Systemstatus“ (docker build --build-arg APP_COMMIT=$(git rev-parse HEAD)).
ARG APP_COMMIT=""
ENV APP_COMMIT=${APP_COMMIT}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/platform/dist \
    TZ=Europe/Berlin
WORKDIR /app
# Alle Dateien gehören root und sind für den Laufzeitbenutzer nur lesbar.
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server/register.mjs server/resolve-ts.mjs ./server/
COPY server/src ./server/src
# Von der API importierte Fachlogik (Pausenregeln, Typen, TOTP) – TypeScript, direkt von Node ausgeführt.
COPY platform/src/core ./platform/src/core
COPY platform/src/data ./platform/src/data
COPY platform/src/security ./platform/src/security
# Migrationen (Job "migrate") und Demo-Daten (nur mit MIGRATE_SEED=1, in Produktion verboten).
COPY db ./db
COPY --from=build /src/platform/dist ./platform/dist

# Benutzer "node" (UID 1000) aus dem Basis-Image – kein root zur Laufzeit.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Entspricht "npm run start:server", aber ohne npm als Zwischenprozess (SIGTERM erreicht Node direkt).
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs", "server/src/main.ts"]
