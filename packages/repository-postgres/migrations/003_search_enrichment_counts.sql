-- Pedido explícito del usuario: el spinner de carga del frontend no puede
-- desaparecer en "done" — "done" solo significa que el listado terminó,
-- el enriquecimiento en segundo plano (company-detail) puede seguir un
-- rato más (sección 10). Estos dos contadores permiten detectar cuándo
-- TODO terminó de verdad: search-list incrementa company_detail_enqueued
-- una vez por cada company-detail que encola; company-detail incrementa
-- company_detail_completed al terminar cada job (éxito o company.failed,
-- nunca en "blocked"). Cuando coinciden y el listado ya es terminal, se
-- publica el evento SSE "enrichment.done".

ALTER TABLE searches ADD COLUMN company_detail_enqueued INT NOT NULL DEFAULT 0;
ALTER TABLE searches ADD COLUMN company_detail_completed INT NOT NULL DEFAULT 0;
