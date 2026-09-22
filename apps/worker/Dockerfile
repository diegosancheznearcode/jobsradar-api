# Fase 0/6.2: el login/renovación de sesión de Wellfound necesita un navegador
# real (Playwright). Esta imagen base es un placeholder de Fase 1 — se cambia
# a la imagen oficial de Playwright en la Fase 4 cuando se implemente
# BrowserClient.
FROM node:22-alpine AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/adapter-wellfound/package.json packages/adapter-wellfound/package.json
COPY packages/events-redis/package.json packages/events-redis/package.json
COPY packages/repository-postgres/package.json packages/repository-postgres/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# pnpm -r respeta el orden topológico del workspace (contracts/domain primero,
# apps al final) — evita tener que listar cada paquete intermedio a mano acá.
RUN pnpm -r run build

FROM node:22-alpine AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo .
# 8080: matches container_port in Terraform's run.tf. The worker has no HTTP
# API of its own; this is only for Cloud Run's startup/liveness probe.
EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
