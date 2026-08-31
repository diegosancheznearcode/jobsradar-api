# JobsRadar — Arquitectura y Especificación

> Documento de especificación para desarrollo asistido por IA (spec-kit / GitHub Copilot).
> Toda decisión aquí es vinculante. Si el código contradice este documento, el documento gana.

---

## 1. Contexto y alcance

**JobsRadar** es una aplicación web que replica el buscador de Wellfound (job
title + location + remote), recorre las primeras **50 empresas remotas** de los
resultados, complementa cada una con su(s) vacante(s) destacada(s) y, cuando hay
sesión disponible, con el perfil de empresa para founders, y consolida la
información en una tabla exportable.

Frontend y backend son **repositorios separados** (`jobsradar-web` y
`jobsradar-api`) con despliegues independientes — ver sección 9.

### 1.1 Alcance de datos — qué SÍ se extrae

| Campo | Fuente confirmada (Fase 0) | Disponibilidad esperada |
|---|---|---|
| Nombre de empresa | Listado (`/role/r/{rol}`, estado hidratado) | Alta |
| Descripción / pitch | Listado (`highConcept`) | Alta |
| Tamaño (`1-10 Employees`) | Listado (`companySize`) | Alta |
| Mercado / industria | Perfil de empresa (`marketTaggings`) o detalle de vacante (JSON-LD `industry`) — redundante entre ambas fuentes | Media-alta |
| Sitio web | Perfil de empresa (`companyUrl`) o detalle de vacante (JSON-LD `hiringOrganization.sameAs`) — redundante | Media-alta |
| Roles abiertos (título, ubicación, remoto) | Listado (1-2 destacados por empresa) + detalle de vacante | Alta para lo destacado; incompleto si la empresa publica más roles de los que el listado muestra |
| Link de aplicación | URL canónica de `/jobs/{id}` — Wellfound es el flujo de aplicación cuando `atsSource` es `null`, no hay ATS externo | Alta |
| Nombre de founder | Perfil de empresa (`/company/{slug}` o `/company/{slug}/people`, campo `currentFounderRoles`) — requiere **sesión autenticada válida** (cookies con `cf_clearance`), no necesariamente Playwright por request | Media — depende de que la empresa haya completado su sección "People"; una empresa con `completeness.incompleteSections` incluyendo `PEOPLE` puede no tener founders cargados aunque la sesión funcione |
| URL de perfil del founder (Wellfound / LinkedIn) | Perfil Wellfound del founder (`/u/{slug}`, desde `User.pathName`) confirmado disponible; **no** se observó un campo de LinkedIn externo en esta consulta | Media (Wellfound) / Baja (LinkedIn externo — sin confirmar aún) |

> Confirmado empíricamente en Fase 0 (2026-08-25) contra `/role/r/backend-engineer`,
> `/jobs/{id}`, `/company/{slug}` (anónimo y autenticado) y `/company/{slug}/people`
> (autenticado). Detalle y fixtures en la sección 12.

### 1.2 Alcance de datos — qué NO se extrae

- **Emails.** No están expuestos en el sitio, ni con sesión iniciada. La columna de
  contacto del producto se modela como `contact_url`, NUNCA como `email`.
- Datos de candidatos. Fuera de alcance por completo.
- Histórico de vacantes. Solo se captura el estado actual.

### 1.3 Restricciones no funcionales

- El descubrimiento de 50 empresas debe completarse en **≤ 10 minutos**.
- El sistema debe degradar sin fallar: una empresa que no se pudo parsear se marca
  como parcial, no aborta la búsqueda.
- Ningún dato personal se persiste sin `source` y `fetched_at`.

---

## 2. Decisiones de arquitectura

| ID | Decisión | Justificación |
|---|---|---|
| AD-01 | Pipeline asíncrono con colas, no request/response | ~55 requests con espaciado = minutos, no milisegundos |
| AD-02 | Atacar rutas SEO `/role/r/{rol}`, no la SPA `/jobs` | Confirmado: 200 OK sin bloqueo, servido desde caché de Cloudflare |
| AD-03 | El listado (`/role/r/{rol}`) + detalle de vacante (`/jobs/{id}`) cubren nombre/tamaño/pitch/roles/market/website sin sesión; el perfil de empresa (`/company/{slug}` + `/people`) sigue siendo la única fuente de founders, y también expone market/website de forma redundante — pero solo con sesión autenticada | Confirmado con cookies de sesión real: el perfil ya no es un 403, trae `currentFounderRoles`, `companyUrl`, `linkedInUrl`, `marketTaggings` completos |
| AD-04 | Cascada JSON-LD → estado hidratado → CSS | Confirmado: `json_ld` gana en detalle de vacante, `hydrated_state` gana en listado y en perfil de empresa (autenticado); ninguna ruta necesitó `css` todavía |
| AD-05 | `fetch` + `cheerio` para las tres rutas, **incluido el perfil de empresa**, siempre que existan cookies de sesión válidas (`cf_clearance` + sesión). Playwright se reserva para el login inicial / renovación de esa sesión, no para scrapear cada empresa | Confirmado: con cookies de una sesión logueada, `curl` anónimo (sin navegador) obtuvo 200 OK y datos completos en `/company/{slug}`; sin cookies, siempre 403 `Cf-Mitigated: challenge` |
| AD-06 | BullMQ + Redis para orquestación | Reintentos, prioridades, estado observable |
| AD-07 | Sin ORM: `postgres.js` con queries explícitas en el repositorio | Regla de proyecto |
| AD-08 | Arquitectura hexagonal (domain / application / infrastructure) en **ambos** repos, no solo en el backend | En `jobsradar-api` aísla la fragilidad del scraping en un solo adaptador; en `jobsradar-web` aísla la UI de cómo se habla con el API/SSE — cambiar de `fetch` a otra librería, o el contrato del API, no debería tocar componentes |
| AD-09 | Circuit breaker global ante captcha; nunca evasión de fingerprint | Confirmado: 403 `Cf-Mitigated: challenge` en `/company/{slug}` documentado tal cual, sin intento de evasión |
| AD-10 | Selectores CSS en config externa, no en código | Cambio de DOM = cambio de config, no de release |
| AD-11 | `jobsradar-web` y `jobsradar-api` son repositorios git separados, no un monorepo | Despliegues, ciclos de release y equipos potencialmente independientes para frontend y backend |

---

## 3. Construcción de URL (reemplaza la simulación del formulario)

El frontend NO simula clics. Construye una ruta.

```
remote = true              → https://wellfound.com/role/r/{role-slug}
remote = false + location  → https://wellfound.com/role/l/{role-slug}/{location-slug}
sin filtros                → https://wellfound.com/role/{role-slug}
```

`role-slug` y `location-slug`: minúsculas, sin acentos, espacios → `-`.

> **Fase 0 confirmó:** paginación por query param `?page={n}` (ej.
> `/role/r/backend-engineer?page=2`), servida como enlaces `<a href="...">` reales
> en el HTML — no hay scroll infinito. `perPage` fijo en 20 resultados; el total
> de páginas viene en el propio estado hidratado (`pageCount`, `totalStartupCount`).

---

## 4. Modelo de dominio

### 4.1 Esquemas Zod (`packages/contracts`)

```ts
import { z } from 'zod';

export const SearchCriteriaSchema = z.object({
  jobTitle:   z.string().min(2).max(80),
  location:   z.string().max(80).optional(),
  remoteOnly: z.boolean().default(true),
  targetCompanies: z.number().int().min(1).max(50).default(50),
  // Opcional (v0.2.0, Fase 10) — filtra contra el tope superior del rango
  // que ya trae `size` ("11-50 Employees" -> 50). Sin este campo, no se
  // filtra por tamaño. Ver companySizeFilter.ts (apps/worker).
  maxCompanySize: z.number().int().positive().optional(),
});

export const FounderSchema = z.object({
  name:        z.string().min(1),
  role:        z.string().nullable(),
  profileUrl:  z.string().url().nullable(),
  linkedinUrl: z.string().url().nullable(),
  source:      z.enum(['company_profile', 'job_detail']),
});

export const JobPostingSchema = z.object({
  externalId: z.string(),
  title:      z.string().min(1),
  location:   z.string().nullable(),
  isRemote:   z.boolean(),
  applyUrl:   z.string().url(),
  postedAt:   z.coerce.date().nullable(),
});

export const CompanySchema = z.object({
  slug:        z.string().min(1),
  name:        z.string().min(1),
  pitch:       z.string().nullable(),
  size:        z.string().nullable(),      // texto crudo: "1-10 Employees"
  market:      z.string().nullable(),
  websiteUrl:  z.string().url().nullable(),
  wellfoundUrl: z.string().url(),
  founders:    z.array(FounderSchema).default([]),
  jobs:        z.array(JobPostingSchema).default([]),
  extraction:  z.object({
    strategy:   z.enum(['json_ld', 'hydrated_state', 'css']),
    confidence: z.number().min(0).max(1),
    missing:    z.array(z.string()).default([]),
  }),
});

export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>;
export type Company = z.infer<typeof CompanySchema>;
```

**Regla de nulabilidad:** un campo ausente es `null` y su nombre entra en
`extraction.missing`. Nunca cadena vacía, nunca valor inventado.

**Fuente confirmada por campo (Fase 0):** `slug`, `name`, `size` y `pitch`, más
hasta 2 `jobs` destacados, vienen del estado hidratado del listado; `market` y
`websiteUrl` están duplicados entre el JSON-LD de `/jobs/{id}` (`industry`,
`hiringOrganization.sameAs`) y el estado hidratado del perfil de empresa
(`marketTaggings`, `companyUrl`) — usar el que responda primero; `founders` es
el único campo que depende exclusivamente del perfil de empresa
(`currentFounderRoles` → `StartupRole` → `User`), accedido con `HttpClient` +
cookies de sesión válidas. En la muestra de Fase 0 el detalle de vacante no
trajo datos de founders — `source: 'job_detail'` queda en el esquema pero su uso
real está por confirmar contra más empresas.

### 4.2 Result Object

```ts
export type Result<T, E> =
  | { ok: true;  value: T }
  | { ok: false; error: E };

export type ExtractionError =
  | { kind: 'blocked';        retryable: true;  detail: string }
  | { kind: 'not_found';      retryable: false }
  | { kind: 'parse_failed';   retryable: false; strategy: string; html: string }
  | { kind: 'rate_limited';   retryable: true;  retryAfterMs: number };
```

`blocked` y `rate_limited` disparan el circuit breaker. `parse_failed` guarda el HTML
como fixture candidata y sigue.

---

## 5. Puertos

```ts
export interface JobSourcePort {
  // Ampliado en Fase 5: devuelve Company[] (parciales, ver sección 6.1
  // resultado de Fase 3), no solo slugs — el listado ya trae nombre/pitch/
  // tamaño/roles destacados sin sesión, y `slug` ya es un campo de Company.
  listCompanies(
    criteria: SearchCriteria,
    page: number
  ): Promise<Result<{ companies: Company[]; hasMore: boolean }, ExtractionError>>;

  getCompany(slug: string): Promise<Result<Company, ExtractionError>>;
}

export interface SearchRepositoryPort {
  create(criteria: SearchCriteria): Promise<string>;          // searchId
  attachCompany(searchId: string, company: Company, rank: number): Promise<void>;
  findCompanyBySlug(slug: string, maxAgeHours: number): Promise<Company | null>;
  getSnapshot(searchId: string): Promise<SearchSnapshot>;
  // Agregado en Fase 6 (acordado con el usuario): sin esto, GET
  // /api/searches/:id (sección 7) siempre habría mostrado "queued".
  updateStatus(searchId: string, status: SearchSnapshot["status"]): Promise<void>;
}

export interface EventPublisherPort {
  publish(searchId: string, event: SearchEvent): Promise<void>;
}
```

`EventPublisherPort` no define cómo alguien se suscribe — el documento
original no cubría el transporte entre procesos (worker publica, la API
del SSE escucha). Fase 6 lo resolvió con Redis pub/sub
(`packages/events-redis`, ver sección 9) y una función `subscribeToSearch`
al lado de `RedisEventPublisher`, fuera del puerto formal.

`findCompanyBySlug` es el caché que evita re-scrapear una empresa vista hace días.
Es lo que hace el sistema sostenible.

`getCompany` usa `HttpClient` para las tres rutas (listado, detalle de vacante,
perfil de empresa) siempre que tenga una sesión válida cargada; `BrowserClient`
solo entra en juego para obtener o renovar esa sesión (login interactivo), no
como motor de scraping por empresa — ver sección 6.

---

## 6. Adaptador Wellfound

Un solo adaptador, tres sub-parsers, una cascada.

```
infrastructure/wellfound/
├── WellfoundAdapter.ts        # implementa JobSourcePort
├── HttpClient.ts              # fetch + cookies de sesión + espaciado + jitter
├── BrowserClient.ts           # Playwright, solo para login/renovación de sesión
├── parsers/
│   ├── RoleListingParser.ts   # /role/r/{rol}         → slugs + name/size/pitch/jobs destacados
│   ├── CompanyProfileParser.ts# /company/{slug}(/people) → founders + market/website (requiere sesión)
│   └── JobDetailParser.ts     # /jobs/{id}            → JobPosting + market/websiteUrl (sin sesión)
└── selectors.config.json      # AD-10
```

### 6.1 Cascada de extracción (obligatoria en cada parser)

```ts
const strategies = [
  parseJsonLd,          // <script type="application/ld+json">
  parseHydratedState,   // __NEXT_DATA__ u equivalente
  parseCss,             // selectors.config.json
];
```

Se devuelve el primer resultado que valide contra el esquema Zod, registrando
qué estrategia ganó en `extraction.strategy`. Si las tres fallan → `parse_failed`.

**Ganadores confirmados en Fase 0:** `RoleListingParser` → `hydrated_state`;
`JobDetailParser` → `json_ld`; `CompanyProfileParser` → `hydrated_state`
(confirmado con sesión autenticada). La cascada se mantiene en código por
resiliencia ante rediseños, pero hoy ninguna ruta necesita `parseCss`. Un 403
`Cf-Mitigated: challenge` en `/company/{slug}` no es `parse_failed`, es
`blocked` — señal de que la sesión (`cf_clearance`) expiró o no se cargó, no de
que el parser esté roto.

### 6.2 Política de ritmo

| Parámetro | Valor |
|---|---|
| Concurrencia | 1 worker al inicio, máximo 2 |
| Espaciado | 6-10 s con jitter aleatorio |
| Reintentos | 3, backoff exponencial + jitter — solo ante `rate_limited` (429/5xx/red). Un `blocked` nunca se reintenta, se propaga directo (Fase 4) |
| Circuit breaker | Pausa toda la búsqueda al primer captcha |
| Sesión | `storageState` de Playwright en disco (cookies, incluyendo `cf_clearance`), login manual una vez — **obligatoria** para pasar el challenge de Cloudflare en `/company/{slug}` (403 confirmado en Fase 0 sin ella; 200 OK confirmado con ella, vía `fetch` plano, sin necesidad de navegador por request). `cf_clearance` tiene un TTL desconocido y posiblemente atado a IP/fingerprint — pendiente medir en Fase 4 cuánto dura y si sobrevive un cambio de IP del worker; al expirar, tratar como `blocked` y disparar una renovación de sesión vía `BrowserClient` |

---

## 7. Contrato de API

```
POST /api/searches              → 202 { searchId }
GET  /api/searches/:id          → { status, progress, companies[] }
GET  /api/searches/:id/stream   → SSE
GET  /api/searches/:id/export   → text/csv
```

### 7.1 Eventos SSE

```ts
type SearchEvent =
  | { type: 'progress';       found: number; target: number; page: number }
  | { type: 'company.found';  company: Company; rank: number }
  | { type: 'company.failed'; slug: string; reason: string }
  | { type: 'paused';         reason: 'blocked' | 'rate_limited'; resumeAt: string }
  | { type: 'done';           total: number; partial: number }
  | { type: 'error';          message: string };
```

`company.failed` se emite y se muestra en la UI. Una búsqueda con 47 de 50 empresas
es un éxito, no un fallo.

Como `jobsradar-web` y `jobsradar-api` son repos y despliegues separados (AD-11),
el API vive en un origen distinto al del frontend: `api` debe habilitar CORS
explícito solo para el o los orígenes de `jobsradar-web` (por entorno: local,
staging, producción), incluyendo el endpoint SSE (`GET
/api/searches/:id/stream`), que además necesita `Cache-Control: no-cache` y
mantener la conexión abierta detrás de cualquier proxy/load balancer.

**Bug real, encontrado probando la UI real contra el despliegue local
(docker-compose) — no en Fase 6, donde solo se testeó con `app.inject()`**: el
handler de `/stream` escribe la respuesta con `reply.raw.writeHead()` para
poder ir mandando frames a medida que llegan eventos — eso evita por completo
el ciclo de `reply` de Fastify, así que el hook `onSend` de `@fastify/cors`
nunca corre ahí, a diferencia de las demás rutas (`reply.send()`/
`reply.header()`). El navegador bloqueaba el `EventSource` por CORS aunque el
origin estuviera en `allowedOrigins`. `app.inject()` no lo había atrapado
porque los tests de Fase 6 nunca mandaban un header `Origin` en la request
simulada. Se arregló agregando `Access-Control-Allow-Origin` a mano en el
`writeHead()` (reflejando el origin solo si está en `allowedOrigins`, mismo
criterio que `@fastify/cors`) y se agregaron dos tests que sí mandan `Origin`
para que esto no vuelva a pasar desapercibido.

---

## 8. Esquema de base de datos

```sql
-- Ajustado en Fase 5 respecto a la versión original de esta sección — ver
-- el resultado de Fase 5 más abajo para el porqué de cada cambio
-- (target_companies, extraction_*, profile_url/linkedin_url).
CREATE TABLE searches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_title        TEXT NOT NULL,
  location         TEXT,
  remote_only      BOOLEAN NOT NULL DEFAULT TRUE,
  target_companies INT NOT NULL,
  status           TEXT NOT NULL,          -- queued|running|paused|done|failed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  pitch                 TEXT,
  size                  TEXT,
  market                TEXT,
  website_url           TEXT,
  wellfound_url         TEXT NOT NULL,
  extraction_strategy   TEXT NOT NULL,     -- json_ld | hydrated_state | css
  extraction_confidence REAL NOT NULL,
  extraction_missing    TEXT[] NOT NULL DEFAULT '{}',
  scraped_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE founders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  role         TEXT,
  profile_url  TEXT,                   -- NUNCA email
  linkedin_url TEXT,                   -- NUNCA email
  source       TEXT NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_postings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title       TEXT NOT NULL,
  location    TEXT,
  is_remote   BOOLEAN NOT NULL DEFAULT FALSE,
  apply_url   TEXT NOT NULL,
  posted_at   TIMESTAMPTZ,
  UNIQUE (company_id, external_id)
);

CREATE TABLE search_results (
  search_id  UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  rank       INT  NOT NULL,
  PRIMARY KEY (search_id, company_id)
);
```

La separación `companies` / `search_results` es deliberada: una empresa se scrapea
una vez y se reutiliza en todas las búsquedas posteriores.

---

## 9. Estructura de repositorios

Dos repositorios independientes, no un monorepo (AD-11):

```
jobsradar-api/                  # backend — repo separado
├── apps/
│   ├── api/                    # Fastify — BFF, SSE, exportación
│   └── worker/                 # Consumidores BullMQ — processors/ (sección 10)
├── packages/
│   ├── domain/                 # Value Objects, entidades, puertos, Result — interno, no se publica
│   ├── contracts/               # Esquemas Zod — publicado como @diegosancheznearcode/contracts
│   ├── adapter-wellfound/       # implementa JobSourcePort — parsers + HttpClient/BrowserClient (sección 6)
│   ├── repository-postgres/     # implementa SearchRepositoryPort — postgres.js, sin ORM (sección 8)
│   └── events-redis/            # implementa EventPublisherPort + subscribeToSearch (Redis pub/sub, sección 5)
└── docker-compose.yml          # postgres, redis, api, worker

jobsradar-web/                  # frontend — repo separado, también hexagonal (AD-08)
├── src/
│   ├── domain/                 # tipos/entidades de UI derivados de @diegosancheznearcode/contracts, sin React
│   ├── application/             # casos de uso (runSearch, exportResults) + puertos (ver abajo)
│   ├── infrastructure/          # adaptadores: HttpSearchAdapter, SseAdapter, CsvExportAdapter
│   └── ui/                      # componentes, páginas, hooks (React 19 + Vite + TanStack Query/Table + Tailwind) — consume application/ solo a través de los puertos
└── package.json                 # depende de @diegosancheznearcode/contracts como paquete versionado
```

`@diegosancheznearcode/contracts` se publica desde `jobsradar-api` a GitHub Packages
en cada push a `main` (workflow `publish-contracts`, condicionado a que la
versión en `packages/contracts/package.json` haya cambiado); `jobsradar-web` lo
instala como dependencia normal (`^0.1.0`), no por workspace compartido — ver
Fase 9 más abajo. `packages/domain` (backend) queda interno al backend — no se
publica ni lo consume el frontend; `jobsradar-web` tiene su propia carpeta
`domain/`, ligera, construida sobre los tipos de `contracts`, no sobre las
entidades/puertos del backend.

`packages/adapter-wellfound` (decisión de Fase 3, la sección 6 original no
fijaba dónde vivía): paquete propio en vez de código embebido en
`apps/worker`, para poder testear los parsers contra fixtures sin arrancar
el worker completo (sección 11) y para que `apps/api` también pueda
importarlo si en algún momento necesita `getCompany` fuera de una cola.
Depende de `@jobsradar/domain` (implementa `JobSourcePort`) y de
`@diegosancheznearcode/contracts` (valida su salida contra los esquemas Zod). Sus
fixtures HTML viven en `packages/adapter-wellfound/fixtures/`, copiadas y
redactadas desde las que generó la investigación de Fase 0.

### 9.1 Puertos del frontend (`jobsradar-web`)

```ts
export interface SearchPort {
  start(criteria: SearchCriteria): Promise<{ searchId: string }>;
  subscribe(searchId: string, onEvent: (event: SearchEvent) => void): () => void; // devuelve unsubscribe
}

export interface ExportPort {
  downloadCsv(searchId: string): Promise<void>;
}
```

`infrastructure/HttpSearchAdapter.ts` implementa `SearchPort` contra el API REST
de `jobsradar-api`; `infrastructure/SseAdapter.ts` implementa la parte de
`subscribe` con `EventSource` sobre `GET /api/searches/:id/stream`;
`infrastructure/CsvExportAdapter.ts` implementa `ExportPort` contra
`GET /api/searches/:id/export`. Los componentes de `ui/` y los hooks de
`application/` (p. ej. `useSearch`) nunca importan `fetch` ni `EventSource`
directamente — solo los puertos. Esto es lo que permite, por ejemplo, cambiar
SSE por polling sin tocar un solo componente.

Docker Compose vive solo en `jobsradar-api` (`postgres`, `redis`, `api`,
`worker`); `jobsradar-web` corre con su propio dev server (Vite) y se despliega
por separado (ver sección 7.1 sobre CORS entre ambos orígenes).

Fase 0 determinó que el navegador es necesario, pero solo para el login inicial
y la renovación periódica de sesión — el scraping de cada empresa corre por
`fetch` reutilizando esa sesión. El worker usa la imagen oficial de Playwright
igual, ya que ese login ocurre dentro del mismo proceso.

### Fase 7 — resultado (2026-08-26)

`domain/index.ts` termina re-exportando no solo los tipos de
`@diegosancheznearcode/contracts` sino también los esquemas Zod (`SearchCriteriaSchema`,
`SearchEventSchema`) — el formulario valida lo que manda con el primero, y
`SseAdapter` valida en runtime cada frame SSE con el segundo antes de
pasarlo a `application/` (un mensaje que no matchea se ignora, no tira la
conexión).

`application/useSearch.ts` reemplaza el `useMutation` placeholder de Fase 1
por una máquina de estados completa (`idle → starting → running →
paused|done|error`) que consume los 6 tipos de `SearchEvent` de la sección
7.1 (`progress`, `company.found`, `company.failed`, `paused`, `done`,
`error`) vía una función pura `applySearchEvent`, testeada aparte del hook.
`ui/` (`SearchForm`, `ResultsTable`, `StatusPanel`) solo ve ese estado ya
acumulado — nunca `SearchEvent` crudo ni `SearchPort.subscribe`
directamente.

Dos bugs reales encontrados en esta fase, ninguno relacionado con la lógica
de negocio:

- `@tanstack/react-table` se actualizó a v9 (que rediseñó toda la API:
  `useTable`/`createTableHook`) sin que el `package.json` cambiara de rango
  — v9 sigue publicando la API v8 (`useReactTable`/`createColumnHelper`/
  `getCoreRowModel`) bajo el entrypoint `@tanstack/react-table/legacy`,
  soporte oficial de migración. Ese shim además tiene un problema de
  varianza en `TValue` al tipar un array de columnas heterogéneas por
  fuera de la llamada a `useLegacyTable()` — la única forma que compiló
  fue declarar el array inline y castearlo con `as unknown as
  LegacyColumnDef<Company>[]`; cada columna individual sigue
  type-checkeada contra `Company`, el cast solo destraba la unión final.
- Sin `test.globals: true` en `vite.config.ts`, `@testing-library/react`
  nunca encuentra un `afterEach` global para autoregistrar su limpieza del
  DOM entre tests — los `render()` de un archivo se iban acumulando y las
  queries por rol/texto empezaban a matchear más de un elemento. Se agregó
  un `afterEach(cleanup)` explícito en `src/test-setup.ts`.

30 tests (RTL + MSW + un doble mínimo de `EventSource`, que jsdom no
implementa) cubriendo formulario, tabla, panel de estado, el hook de
búsqueda y los 3 adaptadores de infraestructura. No se verificó
visualmente en un navegador real — este entorno no tiene esa herramienta;
sí se confirmó que el build de producción compila, que el dev server sirve
y transforma todos los módulos sin error, y que el conjunto de tests pasa.

### Fase 9 — resultado (2026-08-26)

`@jobsradar/contracts` se renombró a `@diegosancheznearcode/contracts`: GitHub
Packages exige que el scope de un paquete npm coincida con el dueño del
repositorio que lo publica, así que `@jobsradar/*` no era publicable ahí sin
mover el repo a una organización propia. Se optó por renombrar en vez de crear
una organización solo para esto — el resto de paquetes internos
(`@jobsradar/domain`) se queda como está porque nunca se publica, solo se
resuelve por workspace.

`packages/contracts/package.json` gana `publishConfig.registry` apuntando a
GitHub Packages. El workflow de CI de `jobsradar-api` gana un job
`publish-contracts` (depende de `build-test`, corre solo en push a `main`)
que compara la versión local contra `npm view` antes de publicar, para que un
push sin bump de versión no falle intentando republicar la misma versión —
bumpear `packages/contracts/package.json` es lo que dispara una publicación
nueva. Usa el `GITHUB_TOKEN` por defecto del workflow (con `permissions:
packages: write` a nivel de job), sin necesitar un secret nuevo, porque
publicar es una acción sobre el propio repo.

Del lado de `jobsradar-web`, el workaround de Fase 1 (clonar `jobsradar-api`
como sibling en CI y symlinkear `packages/contracts/dist` para resolver el
`file:` dependency) desaparece por completo: la dependencia pasa a ser
`"@diegosancheznearcode/contracts": "^0.1.0"`, una versión real. Instalarla
requiere autenticación contra `npm.pkg.github.com` (GitHub Packages no sirve
paquetes de un repo privado sin token, ni siquiera de solo lectura) — se
agrega un `.npmrc` con el registro scopeado y el token vía `NODE_AUTH_TOKEN`
(que `actions/setup-node` inyecta en un `.npmrc` de usuario, no en el del
repo — pnpm rechaza expandir variables de entorno en credenciales que vienen
de un `.npmrc` de proyecto committeado, por seguridad). El CI reutiliza el
secret `JOBSRADAR_API_RO_TOKEN`.

Un hallazgo real acá: un **fine-grained PAT con permiso "Packages:
Read-only"** no sirve para leer de `npm.pkg.github.com` — el registro
responde `403 permission_denied: "The token provided does not match
expected scopes"` sin importar el permiso configurado en el token. GitHub
Packages solo reconoce los scopes OAuth clásicos (`read:packages`, y `repo`
para paquetes de un repo privado); no hay forma de hacerlo funcionar con un
fine-grained token al momento de escribir esto. `JOBSRADAR_API_RO_TOKEN`
terminó siendo un **classic PAT** con `read:packages` + `repo`, no el
fine-grained token de Fase 1 con un permiso agregado como se planeó
originalmente.

Dos bugs reales encontrados en `apps/api/Dockerfile` y `apps/worker/Dockerfile`,
sin relación con el rename pero descubiertos al auditarlos por la mención a
`@jobsradar/contracts` en su `RUN pnpm --filter`:

- La etapa `deps` nunca copiaba `pnpm-lock.yaml`, así que `pnpm install
  --frozen-lockfile` fallaba siempre y cada build caía silenciosamente al
  fallback `|| pnpm install` — una instalación no reproducible, ignorando el
  lockfile real. Se agregó `pnpm-lock.yaml` al `COPY` y se sacó el fallback.
- La etapa `deps` tampoco copiaba el `package.json` de
  `packages/adapter-wellfound`, `packages/events-redis` ni
  `packages/repository-postgres` (agregados en Fases 4-6, después de que se
  escribieron los Dockerfiles en Fase 1), y el `RUN` de build solo
  compilaba `domain` + `contracts` + la app — ni siquiera intentaba compilar
  esos tres paquetes intermedios de los que `apps/api`/`apps/worker`
  dependen. Un build de estos Dockerfiles nunca hubiera funcionado. Se
  agregaron los `COPY` faltantes y el `RUN` pasó a `pnpm -r run build` (todo
  el workspace, en orden topológico) en vez de listar cada paquete a mano —
  así no vuelve a desincronizarse cuando se agregue un paquete nuevo.
- Sin `.dockerignore`, `COPY . .` en la etapa `build` copiaba el
  `node_modules` del host por encima del que `pnpm install` ya había
  instalado *dentro* del contenedor Linux — en Windows eso rompe binarios
  nativos (`esbuild`, `msgpackr-extract`) en runtime. Se agregó
  `.dockerignore` excluyendo `node_modules`, `dist`, `fixtures` y demás
  archivos que no hacen falta para el build.

Ninguno de estos tres bugs lo hubiera atrapado el CI tal como estaba: corre
`pnpm build/test`, nunca `docker build`, así que un Dockerfile roto podía
quedar así indefinidamente sin que nada lo marcara. Se agrega un job
`docker-build` (independiente de `build-test`, sin servicios de Postgres/Redis)
que construye ambas imágenes en cada push/PR — no las publica ni las corre,
solo confirma que el `docker build` no rompe.

### Fase 11 — resultado (2026-08-31)

Pedido explícito del usuario, probando `SearchForm` en vivo: `remoteOnly`
queda **fijo en `true`**, sin checkbox — se saca el control de la UI (no del
schema; `SearchCriteriaSchema.remoteOnly` sigue existiendo, solo que
`SearchForm` ya no lo expone). Como consecuencia directa, el input de
`location` también se saca del formulario: `buildRoleListingUrl` (sección
3) solo usa `criteria.location` cuando `remoteOnly` es `false` — con
`remoteOnly` fijo en `true`, ese input nunca hubiera tenido efecto en la
búsqueda, y dejarlo hubiera sido un control fantasma.

El usuario sí quería un filtro de ubicación en alguna parte — como
Wellfound no combina remoto + ubicación en una misma búsqueda (Fase 0), el
filtro no puede ir contra la API: va **client-side, sobre `ResultsTable`**.
Cada `JobPosting` ya trae su propio `location` (ej. "San Mateo", aunque el
rol sea remoto — el `remoteOnly` de la búsqueda no implica que cada job
individual no tenga una ciudad asociada); se agrega una columna "Ubicación"
(únicas, `job.location` por empresa) y un input que filtra las filas por
coincidencia de substring, sin volver a pegarle a Wellfound.

---

## 10. Colas

| Cola | Trabajo | Concurrencia |
|---|---|---|
| `search-list` | Pagina `/role/r/{rol}` hasta juntar 50 slugs únicos | 1 |
| `job-detail` | `GET /jobs/{id}` → `market`/`websiteUrl`/`jobs` vía `HttpClient`, sin sesión | 1-2 |
| `company-detail` | `GET /company/{slug}(/people)` → `founders` + `market`/`website` vía `HttpClient` + cookies de sesión | 1-2 — mismo costo que `job-detail` una vez que hay sesión cargada; cae a 1 y dispara renovación de sesión si empieza a recibir 403 |

Idempotencia: clave `(searchId, slug)`. Un reintento nunca duplica una fila.

**Implementación (Fase 5):** cada cola tiene un processor en
`apps/worker/src/processors/` como función pura con dependencias inyectadas
(`adapter`, `repository`, funciones `enqueue*`) — `apps/worker/src/index.ts`
solo los conecta a `Worker`/`Queue` de BullMQ reales. `search-list` deriva
`rank` de `repository.getSnapshot(searchId).progress.found` (no un contador
aparte) y encola `company-detail` por cada empresa nueva; solo encola la
página siguiente si `hasMore` y todavía no se llegó a `target_companies`.
`company-detail`/`job-detail` pasan `rank: 0` a `attachCompany` — se ignora
porque `search-list` ya insertó la fila real en `search_results`
(`ON CONFLICT DO NOTHING`). Ninguno relanza automáticamente ante `blocked`:
se loguea y la búsqueda queda parcial en esa empresa (sección 1.3, "degradar
sin fallar"), no reintenta contra un bloqueo que no se va a resolver solo.

`search-list` también corta la paginación a los `maxPages` (10 por defecto,
inyectable) aunque `hasMore` siga en `true` y no se haya llegado a
`target_companies` — decisión de la Fase 10 (probando el despliegue local
contra Wellfound real): sin este tope, un rol con mucho descarte/duplicado
podía paginar indefinidamente. Con `perPage: 20` (Fase 0) y
`targetCompanies` máximo 50, el caso normal necesita ~3 páginas — 10 da
margen sin arriesgar una búsqueda colgada. Al llegar al tope la búsqueda
cierra igual que si `hasMore` fuera `false`: `status: done`, parcial si
`found < target`.

`SearchCriteria.maxCompanySize` (sección 4.1, contracts v0.2.0) se filtra acá
también, antes de persistir/contar/encolar cada empresa
(`companySizeFilter.ts`, `matchesMaxCompanySize`) — así `target_companies`
cuenta solo empresas que cumplen el filtro. Filtrar después de traer
`targetCompanies` empresas sin filtrar hubiera devuelto muchas menos de las
pedidas. Un rango abierto (`"5000+ Employees"`) nunca matchea un tope
máximo; `size: null` tampoco, para no arriesgar un falso positivo.

**Publicar un cambio de `contracts`:** bumpear
`packages/contracts/package.json` (`0.1.0` → `0.2.0` para este campo) es lo
que dispara `publish-contracts` en el próximo push a `main` (sección 9,
Fase 9) — sin el bump, el job detecta que la versión ya existe y no
publica nada, y `jobsradar-web` sigue instalando el schema viejo (Zod
descarta en silencio cualquier campo que el consumidor no conoce).

---

## 11. Estrategia de pruebas (TDD estricto: red-green-refactor)

- **Parsers:** tests unitarios contra fixtures HTML en `fixtures/`. Sin red. Son la
  red de seguridad ante cambios de DOM.
- **Adaptador:** tests de integración con las fixtures servidas por MSW.
- **API:** tests de contrato sobre los esquemas Zod.
- **Alerta operativa:** si la tasa de extracción vacía supera el 30 %, los selectores
  se rompieron. Es el síntoma que hay que monitorear. Implementado en Fase 8
  como un `console.warn` desde `WellfoundAdapter` — ver el resultado de esa
  fase más abajo. Deliberadamente **solo log**, sin endpoint HTTP ni
  dashboard: el circuit breaker y las métricas viven en el proceso del
  worker, que no tiene servidor HTTP, y el documento no pedía agregar uno.

Stack: Vitest + React Testing Library + MSW.

---

## 12. Plan de fases

| Fase | Entregable | Bloquea a |
|---|---|---|
| **0** | ✅ Completada (2026-08-25) — fixtures + confirmación de JSON-LD, estado hidratado y paginación | Todo |
| 1 | ✅ Completada (2026-08-25) — Repos `jobsradar-api` + `jobsradar-web` + Docker Compose (backend) + CI en cada uno | 2 |
| 2 | ✅ Completada (2026-08-25) — `packages/domain` + `packages/contracts` con tests | 3, 4 |
| 3 | ✅ Completada (2026-08-25) — Parsers contra fixtures (sin red), en `packages/adapter-wellfound` | 4 |
| 4 | ✅ Completada (2026-08-26) — `WellfoundAdapter` + política de ritmo, todo mockeado (sin red real, ver sección 6.2 resultado) | 5 |
| 5 | ✅ Completada (2026-08-26) — Colas + repositorio + caché, contra Postgres/Redis reales (ver sección 8 resultado) | 6 |
| 6 | ✅ Completada (2026-08-26) — API BFF + SSE (ver sección 7 resultado) | 7 |
| 7 | ✅ Completada (2026-08-26) — Frontend React hexagonal + tabla + exportación (ver sección 9.1 resultado) | — |
| 8 | ✅ Completada (2026-08-26) — Observabilidad + alerta de selectores rotos (ver sección 11 resultado) | — |
| 9 | ✅ Completada (2026-08-26) — `@diegosancheznearcode/contracts` publicado en GitHub Packages, reemplaza el `file:` local entre repos (ver sección 9 resultado) | — |
| 10 | ✅ Completada (2026-08-28) — Despliegue local (docker-compose) validado contra Wellfound real: fix CORS del SSE (sección 7), tope de páginas en `search-list` (sección 10), filtro `maxCompanySize` (sección 4.1, contracts v0.2.0) | — |
| 11 | ✅ Completada (2026-08-31) — `remoteOnly` fijo en `SearchForm` (sección 9.1 resultado), filtro de ubicación client-side en `ResultsTable` | — |

### Fase 0 — checklist concreto (completado)

1. ~~Abrir `wellfound.com/role/r/backend-engineer` en DevTools.~~ → hecho vía
   `fetch` directo (equivalente sin JS, ver punto 2).
2. `application/ld+json` en `/role/r/{rol}` → **no existe** en el listado.
3. Blob de estado hidratado → **sí existe**: `__NEXT_DATA__` con un cache Apollo
   normalizado (`apolloState`). Trae `StartupResult` (name, slug, companySize,
   highConcept, hasta 2 `highlightedJobListings`) y `JobListingSearchResult`
   (título, descripción completa, remoto, ubicación, salario si está publicado).
4. Paginación → query param `?page={n}` con enlaces `<a href>` reales;
   `perPage: 20`, `pageCount` y `totalStartupCount` en el propio estado
   hidratado. No hay scroll infinito.
5. `/company/{slug}` sin sesión → **403 Forbidden, `Cf-Mitigated: challenge`**
   (confirmado en 2 intentos). `/jobs/{id}` sí es accesible sin sesión y trae
   JSON-LD `JobPosting` completo (`hiringOrganization` con nombre + `sameAs` +
   ubicación, `industry`, salario, `datePosted`) pero **no** founders.
6. Sesión anónima vs. autenticada → **probado**. Con las cookies de una sesión
   real logueada (incluyendo `cf_clearance`) pasadas a un `fetch`/`curl` plano
   — sin navegador — `/company/{slug}` respondió **200 OK** con el perfil
   completo en estado hidratado (`__NEXT_DATA__`), y `/company/{slug}/people`
   confirmó el detalle de founders: `currentFounderRoles` → `StartupRole`
   (`title`, `roleDisplayName: "Founder"`) → `User` (`name`, y `pathName` como
   `/u/{slug}`, el perfil Wellfound del founder). También trae `companyUrl`,
   `linkedInUrl` (de la empresa) y `marketTaggings`, redundantes con lo que ya
   daba `/jobs/{id}`. La empresa de prueba tenía `completeness.incompleteSections`
   incluyendo `PEOPLE`, y aun así devolvió 1 founder — confirma que la
   disponibilidad "Media" es por completitud de cada empresa, no por bloqueo
   técnico.
7. Fixtures guardados en `fixtures/`: `role-listing.html`, `company-profile.html`
   (el HTML del challenge anónimo — útil para que el circuit breaker lo
   reconozca en runtime), `job-detail.html`, `company-profile-auth.html`,
   `company-people-auth.html`, más sus `*.headers.txt`.
   > ⚠️ `company-profile-auth.html` y `company-people-auth.html` contienen el
   > nodo "viewer" de la sesión real usada para probar (nombre y email del
   > tester en el propio JSON). **Redactar esos campos antes de commitear estos
   > dos archivos a cualquier repositorio** — no son seguros para usar como
   > fixture de test tal cual.

**Salida de Fase 0:**
- `/role/r/{rol}` → `fetch` + `cheerio`, estrategia `hydrated_state`, sin sesión.
- `/jobs/{id}` → `fetch` + `cheerio`, estrategia `json_ld`, sin sesión.
- `/company/{slug}(/people)` → `fetch` + `cheerio`, estrategia `hydrated_state`,
  **requiere cookies de sesión válidas** (incluyendo `cf_clearance`). Sin ellas,
  siempre 403. Con ellas, no hace falta Playwright por request — solo para
  obtener/renovar esa sesión.
- AD-03 queda confirmado en su forma original: el perfil de empresa sigue
  siendo indispensable (es la única fuente de founders), simplemente estaba
  mal caracterizado el costo real: no es "Playwright siempre", es "sesión
  válida siempre, Playwright solo de vez en cuando".
- Pendiente para Fase 4: medir el TTL real de `cf_clearance` y si depende de
  la IP/fingerprint del proceso que lo obtuvo, para dimensionar cada cuánto
  hay que renovar la sesión.

### Fase 3 — resultado (2026-08-25)

Los 3 parsers y la cascada genérica quedaron implementados en
`packages/adapter-wellfound`, con 17 tests contra los 5 fixtures de Fase 0
(sin red). Decisiones que no estaban en el documento original:

- `extractWithCascade` devuelve `{ data, strategy }`, no solo `data` — así
  `extraction.strategy` (sección 4.1) se puede poblar sin volver a adivinar
  qué estrategia ganó.
- Un 403 de Cloudflare en `CompanyProfileParser` se distingue explícitamente
  de `parse_failed`: se chequea el `<title>Security Check | Wellfound</title>`
  del challenge *antes* de intentar la cascada, y devuelve `blocked`
  directamente (sección 6.1, AD-09).
- `RoleListingParser` valida cada empresa contra `CompanySchema` completo,
  con `market`/`websiteUrl`/`founders` en `null`/`[]` y listados en
  `extraction.missing` — no inventa esos campos, los deja pendientes para
  `JobDetailParser`/`CompanyProfileParser`.
- `humanizeCompanySize` solo tiene confirmado `SIZE_1_10` → `"1-10
  Employees"` contra un fixture real; el resto de tamaños se deriva del
  mismo patrón (`SIZE_<min>_<max|PLUS>`) en vez de una tabla inventada, y si
  no matchea devuelve el enum crudo.
- `RoleListingParser.parseRoleListing` devuelve `Company[]` completos, no
  `{ slugs, hasMore }` como pide la firma de `JobSourcePort.listCompanies`
  (sección 5) — reconciliar ambas formas queda para `WellfoundAdapter` en la
  Fase 4, que decide qué exponer por el puerto y qué guardar directo en el
  repositorio.

### Fase 4 — resultado (2026-08-26)

Implementada **completamente mockeada, sin un solo request real a
wellfound.com** (decisión explícita del usuario) — todos los tests de
`HttpClient`/`BrowserClient`/`WellfoundAdapter` corren contra MSW o contra
fakes inyectados, nunca contra la red. Consecuencia directa: el issue de
medir el TTL real de `cf_clearance` **no se cerró** — el mecanismo para
reaccionar a una sesión vencida existe (ver más abajo), pero la medición
empírica en sí requiere una sesión real en vivo, que queda pendiente para
cuando el usuario decida hacerla.

- `HttpClient`: espaciado 6-10s + jitter entre requests (se salta antes del
  primero), 3 reintentos con backoff exponencial — pero **solo** para
  `rate_limited` (429, 5xx, fallos de red). Un `blocked` (403 +
  `Cf-Mitigated`) nunca se reintenta: se devuelve de inmediato para que el
  circuit breaker se abra "al primer captcha" (AD-09), no después de
  gastar los 3 reintentos.
- Cookies de sesión: `HttpClient` no las manda por default — cada `get()`
  pide `{ withSession: true }` explícitamente, y solo entonces lee el
  `storageState.json` (formato Playwright) y arma el header `Cookie`.
  Confirmado en Fase 0: solo `/company/{slug}` lo necesita.
- `BrowserClient`: **no depende del paquete `playwright`**. `launch()` se
  inyecta desde quien construya el adaptador real (el worker, en una fase
  futura) — así este paquete no necesita Chromium instalado para
  typecheck/build/test. Nunca automatiza credenciales: `ensureSession`/
  `renewSession` abren el navegador y esperan (`waitForURL`) a que una
  persona complete el login a mano, igual que se hizo manualmente en
  Fase 0. El patrón `postLoginUrlPattern` usado por default es una
  suposición razonable, **no confirmada contra Wellfound real** — hay que
  validarlo la primera vez que esto corra en vivo.
- `CircuitBreaker`: estado `closed`/`open` en memoria. Solo `blocked` lo
  abre (no `rate_limited`, que ya se maneja con reintentos, ni
  `not_found`/`parse_failed`, que son errores de una empresa puntual, no
  del acceso global). Mientras está abierto, `WellfoundAdapter` devuelve el
  mismo error sin tocar la red — confirmado con un test que cuenta
  requests. Quién llama a `renewSession()` y luego `breaker.reset()`
  después de un bloqueo es una decisión de orquestación que queda para la
  cola `company-detail` en la Fase 5 (sección 10 ya lo preveía: "cae a 1 y
  dispara renovación de sesión si empieza a recibir 403"), no de
  `WellfoundAdapter` mismo.
- `WellfoundAdapter.getCompany` arma un `Company` completo desde una sola
  petición al perfil (`CompanyProfileParser`, extendido en esta fase para
  también traer `name`/`pitch`/`size` — antes solo daba founders/market/
  website). No incluye `jobs`: esos vienen del listado o del detalle de
  vacante, y combinarlos con lo que da el perfil es trabajo del
  repositorio/caché (Fase 5), no del adaptador.

### Fase 5 — resultado (2026-08-26)

`packages/repository-postgres` probado con Postgres real (no mockeado —
sección 11 no cubre SQL, y mockear postgres.js no prueba el merge/
idempotencia/caché de verdad). Encontré tres huecos entre la sección 8
(SQL) y la sección 4.1 (Zod), los tres del mismo tipo — el SQL no tenía
dónde guardar algo que el esquema Zod exige — resueltos junto con el
usuario:

- `searches.target_companies` no existía; hacía falta para reconstruir
  `progress.target` en `getSnapshot`.
- `founders.contact_url` (una sola columna) se reemplazó por
  `profile_url` + `linkedin_url`, que es lo que `FounderSchema` en
  realidad define y lo que `CompanyProfileParser` ya devuelve por
  separado.
- `companies` no tenía dónde persistir `extraction.strategy/confidence/
  missing`, que `CompanySchema` exige como campo requerido — se agregaron
  `extraction_strategy`/`extraction_confidence`/`extraction_missing`.

`JobSourcePort.listCompanies` también cambió (con el usuario) de
`{ slugs, hasMore }` a `{ companies: Company[], hasMore }` — ver sección 5.

Otras decisiones:

- `attachCompany` hace *merge no destructivo*: `COALESCE(EXCLUDED.campo,
  companies.campo)` en el `UPSERT`, así una llamada posterior con datos
  parciales (ej. `search-list` reprocesando) nunca pisa con `null` lo que
  una llamada anterior más completa (ej. `company-detail`) ya sabía.
  Confirmado con un test que ataca la tabla en ese orden.
- Founders se reemplazan (`DELETE` + `INSERT`) solo cuando la llamada trae
  founders de verdad — una llamada sin founders no borra los que ya había.
- `job-detail` no pasa por `JobSourcePort` (el puerto no lo declara,
  sección 5): el processor depende de `@jobsradar/adapter-wellfound`
  directamente para `parseJobDetail`, tal como la sección 9 ya preveía
  ("para que `apps/api` también pueda importarlo").
- Los tests de Postgres corren con `fileParallelism: false` en
  `apps/worker` — varios archivos de test comparten la misma base y hacen
  `TRUNCATE` en `beforeEach`; en paralelo, un archivo borraba los datos
  que otro acababa de insertar. El CI ahora levanta un servicio Postgres
  real (ver `.github/workflows/ci.yml`).

### Fase 6 — resultado (2026-08-26)

`packages/events-redis` (nuevo) implementa `EventPublisherPort` sobre Redis
pub/sub (`redis.publish`/`redis.subscribe`) — decisión sin alternativa real
dado que AD-06 ya usa Redis para BullMQ. `subscribeToSearch` abre una
conexión de suscripción **nueva por cada cliente SSE** (no una compartida):
así desconectar a un cliente nunca corta a otro escuchando el mismo
`searchId` — probado explícitamente.

`SearchRepositoryPort.updateStatus` (acordado con el usuario, igual que
los cambios de puerto anteriores): sin él, `GET /api/searches/:id` siempre
hubiera mostrado `"queued"`. `search-list` lo llama a `running` al
arrancar cada página y a `done`/`paused`/`failed` al dejar de paginar o
ante un error.

`apps/api` (`src/app.ts`) expone las 4 rutas de la sección 7 contra
Postgres y Redis reales, separado de `index.ts` (que solo arranca el
servidor) para poder testear con `fastify.inject()` sin bindear un puerto.
El SSE (`GET /api/searches/:id/stream`) escribe cada evento como un frame
`data: {...}\n\n` y cierra la conexión solo ante `done`/`error` — los demás
tipos de evento la mantienen abierta.

Los processors del worker ahora publican eventos reales, no solo loguean:
`search-list` emite `company.found` por empresa, `progress` al final de
cada página, y `done`/`paused`/`error` según corresponda;
`company-detail`/`job-detail` emiten `company.failed` en sus errores, y
`company-detail` además pausa toda la búsqueda (`updateStatus` +
evento `paused`) ante `blocked`, porque el circuit breaker del adaptador
(Fase 4) ya frenó al resto de esa cola. Simplificación deliberada: `done`
se publica cuando `search-list` termina de paginar, no cuando termina
toda la enriquecida vía `company-detail`/`job-detail` — esos jobs pueden
seguir corriendo en segundo plano después del evento `done`.

Bug de test encontrado **entre paquetes**, no solo dentro de uno: con
`apps/api` y `apps/worker` corriendo sus tests en paralelo (no dependen
entre sí en el grafo de workspace, así que `pnpm -r` no los serializaba),
ambos atacando la misma Postgres, apareció un deadlock real de Postgres.
`pnpm test` en la raíz ahora corre con `--workspace-concurrency=1` —
mismo problema que el `fileParallelism: false` de Fase 5, un nivel más
arriba (entre paquetes, no solo entre archivos de un paquete). CI también
levanta un servicio Redis, además del Postgres de Fase 5.

### Fase 8 — resultado (2026-08-26)

`ExtractionMetrics` (nuevo, en `packages/adapter-wellfound`): ventana móvil
de las últimas 20 extracciones, alerta si más del 30 % fallaron **y** hay
al menos 5 muestras (evita falsos positivos al arrancar con 1 de 1
fallido). "Extracción vacía" se definió estrictamente como `parse_failed`
con un HTML que sí llegó (200 OK) — `blocked`/`rate_limited`/`not_found`
quedan afuera a propósito: son problemas de acceso a la red o de una
empresa puntual, no de selectores rotos, y `blocked` ya lo cubre el
circuit breaker.

`CircuitBreaker.getMetrics()` agrega `tripCount`/`lastTrippedAt` — a
diferencia de `reset()`, que sí limpia el estado `open`/`lastError`, estos
dos son acumulativos y sobreviven un reset (son "cuántas veces pasó
esto", no "está pasando ahora mismo").

`WellfoundAdapter` ahora recibe `metrics` y un `log` inyectable (default
`console.warn`) como constructor params — cuando `isAboveThreshold()`, loguea
la tasa, el tamaño de la muestra, y el estado + tripCount del circuit
breaker en un solo mensaje. Decisión de alcance (acordada con el usuario):
**solo log, sin endpoint HTTP nuevo** — el breaker y las métricas viven en
el proceso del worker, que no tiene servidor HTTP, y agregar uno para esto
habría sido infraestructura que ni la sección 11 ni el issue de Fase 8
pedían.

Con esto, **las 8 fases del plan original quedan completadas** en
`jobsradar-api`. Lo único pendiente registrado en el Backlog es el TTL
real de `cf_clearance` (Fase 4, requiere una sesión en vivo) y toda la
Fase 7 (frontend, `jobsradar-web`).

---

## 13. Consideraciones legales y de datos personales

- Los términos de servicio de Wellfound restringen el acceso automatizado. El uso de
  este sistema es responsabilidad del operador.
- Nombres y perfiles de founders son datos personales: aplica la Ley 1581 de 2012
  (Colombia) y el GDPR si hay titulares en la UE.
- Todo registro en `founders` guarda `source` y `fetched_at` para trazabilidad.
- Debe existir un procedimiento de borrado por solicitud del titular.
- Política de retención: purgar registros con `fetched_at` mayor a 90 días.
