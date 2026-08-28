# jobsradar-api

Backend de **JobsRadar**: API (Fastify), worker (BullMQ) y los paquetes
`domain` y `contracts` compartidos entre ambos. La especificación completa y
vinculante vive en [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — si el
código y el documento no coinciden, el documento gana.

Repo separado de [`jobsradar-web`](../jobsradar-web) (AD-11); se comunican por
HTTP/SSE, no por import directo.

## Desarrollo

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm dev:api      # apps/api
pnpm dev:worker   # apps/worker
```

## Despliegue local completo (docker-compose)

```bash
touch storageState.json   # placeholder — si no existe, Docker crea un
                           # directorio en su lugar y el bind mount se rompe
docker compose up -d --build
```

Levanta los 4 servicios (postgres, redis, api en :3000, worker). Sin sesión
real, el worker igual arranca y procesa el listado (no requiere login —
Fase 0), pero pausa cada búsqueda al llegar a `/company/{slug}` (founders,
market, website) porque esa ruta sí exige sesión — ver `docker compose logs
worker`. Para habilitar el enriquecimiento completo, generar `storageState.json`
con una sesión real de Wellfound (formato Playwright: `{ cookies: [...] }`,
ver `packages/adapter-wellfound/src/session.ts`) y sobreescribir el placeholder
— `docker-compose.yml` ya lo monta de solo lectura en el worker.

## Estado (Fase 1 — scaffold)

`apps/api` y `apps/worker` arrancan y responden, pero sus rutas/colas reales
son placeholders (`501` / error explícito). `packages/domain` y
`packages/contracts` están vacíos a propósito — se implementan en la Fase 2.
Ver la sección 12 de `docs/ARCHITECTURE.md` para el plan de fases completo.

## Estructura

```
apps/
├── api/        Fastify — BFF, SSE, exportación (sección 7)
└── worker/     Consumidores BullMQ (sección 10)
packages/
├── domain/     Value Objects, puertos, Result (sección 4.2, 5) — interno
└── contracts/  Esquemas Zod — publicado como @diegosancheznearcode/contracts (sección 4.1)
```
