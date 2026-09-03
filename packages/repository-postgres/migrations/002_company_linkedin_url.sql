-- Ver ARCHITECTURE.md sección 8/9.1 resultado Fase 11 — LinkedIn de la
-- EMPRESA (no de un founder puntual). El campo ya existía en los datos de
-- Wellfound desde la Fase 0 (mismo nodo Apollo que website_url), pero
-- nunca se conectó hasta que el usuario lo señaló viendo la página real.

ALTER TABLE companies ADD COLUMN linkedin_url TEXT;
