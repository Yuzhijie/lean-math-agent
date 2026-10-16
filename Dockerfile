# Production image: Next.js app + Lean 4 / Mathlib + REPL (invite-only beta, docs 7e).
#
# Debian (glibc) throughout: the official Lean toolchain and better-sqlite3's prebuilt binary need
# it (Alpine/musl runs neither). The Lean stage downloads Mathlib's prebuilt .olean cache
# (`lake exe cache get`, a few GB) instead of compiling Mathlib, then builds the project and the
# REPL. Expect an image of about 6–7 GB and a first build of 10–20 minutes; later builds reuse the
# Lean layer as long as lean-sandbox/ is unchanged.

# ── Stage 1: Lean toolchain + Mathlib + REPL ──────────────────────────
FROM debian:bookworm-slim AS lean
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
ENV ELAN_HOME=/opt/elan PATH=/opt/elan/bin:$PATH
WORKDIR /app/lean-sandbox
COPY lean-sandbox/lean-toolchain lean-sandbox/lakefile.toml lean-sandbox/lake-manifest.json ./
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
      | sh -s -- -y --no-modify-path --default-toolchain "$(cat lean-toolchain)"
# Dependencies first (cached unless the manifest changes): Mathlib's prebuilt oleans, then the REPL.
RUN lake exe cache get && lake build repl
COPY lean-sandbox/ ./
RUN lake build && test -x .lake/packages/repl/.lake/build/bin/repl

# ── Stage 2: dependencies ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* prisma.config.ts ./
# `npm ci` runs `prisma generate` (postinstall): it needs the schema, the CLI config and its URL helper.
COPY prisma ./prisma
COPY lib/db-url.ts ./lib/db-url.ts
RUN npm ci

# ── Stage 3: build ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN npx prisma generate && npm run build

# ── Stage 4: runner ───────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    ELAN_HOME=/opt/elan PATH=/opt/elan/bin:$PATH \
    LEAN_SANDBOX_PATH=/app/lean-sandbox \
    DATABASE_URL=file:/app/data/prod.db
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs --home /app nextjs \
    && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=lean /opt/elan /opt/elan
COPY --from=lean --chown=nextjs:nodejs /app/lean-sandbox ./lean-sandbox
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs
# better-sqlite3 for the migration script (the standalone output traces only what the app imports).
COPY --from=deps /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps /app/node_modules/bindings ./node_modules/bindings
COPY --from=deps /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

RUN mkdir -p /app/data && chown nextjs:nodejs /app/data
USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Create / update the database tables, then start (the server refuses to start when the
# production configuration is incomplete — see lib/startup-checks.ts).
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
