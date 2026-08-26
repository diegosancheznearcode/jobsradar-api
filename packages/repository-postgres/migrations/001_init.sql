-- Ver ARCHITECTURE.md sección 8, con tres ajustes documentados en Fase 5
-- (packages/repository-postgres/README.md) — todos reconciliando el SQL
-- de la sección 8 con lo que los esquemas Zod de la sección 4.1 en
-- realidad exigen:
--   1. searches.target_companies: no estaba en la sección 8, hace falta
--      para reconstruir progress.target en SearchSnapshot (sección 5).
--   2. founders.contact_url -> profile_url + linkedin_url: la sección 8
--      solo tenía una columna, pero FounderSchema define dos campos
--      separados.
--   3. companies.extraction_*: CompanySchema.extraction es un campo
--      requerido (strategy/confidence/missing) que la sección 8 no tenía
--      dónde persistir.

CREATE TABLE searches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_title        TEXT NOT NULL,
  location         TEXT,
  remote_only      BOOLEAN NOT NULL DEFAULT TRUE,
  target_companies INT NOT NULL,
  status           TEXT NOT NULL, -- queued|running|paused|done|failed
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
  extraction_strategy   TEXT NOT NULL,   -- json_ld | hydrated_state | css
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
