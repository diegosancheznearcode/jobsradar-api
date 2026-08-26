// SearchCriteriaSchema, FounderSchema, JobPostingSchema, CompanySchema y
// SearchEvent viven aquí — ver ARCHITECTURE.md secciones 4.1 y 7.1.
// Implementación pendiente: Fase 2. Se publica como @jobsradar/contracts
// (registro privado, TODO) y jobsradar-web lo consume como dependencia
// versionada — por ahora, referencia local (ver README de jobsradar-web).

import { z } from "zod";

export const PlaceholderSchema = z.object({
  note: z.literal("contracts pendientes — Fase 2"),
});
