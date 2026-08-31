import { z } from "zod";

// Esquemas Zod compartidos entre jobsradar-api y jobsradar-web.
// Ver ARCHITECTURE.md sección 4.1.
//
// Regla de nulabilidad: un campo ausente es `null` y su nombre entra en
// `extraction.missing`. Nunca cadena vacía, nunca valor inventado.

export const SearchCriteriaSchema = z.object({
  jobTitle: z.string().min(2).max(80),
  location: z.string().max(80).optional(),
  remoteOnly: z.boolean().default(true),
  targetCompanies: z.number().int().min(1).max(50).default(50),
  // Filtra por el tope superior del rango que Wellfound expone en `size`
  // ("11-50 Employees" -> 50). Opcional: sin este campo, no se filtra por
  // tamaño (comportamiento original). Ver companySizeFilter.ts.
  maxCompanySize: z.number().int().positive().optional(),
});

export const FounderSchema = z.object({
  name: z.string().min(1),
  role: z.string().nullable(),
  profileUrl: z.string().url().nullable(),
  linkedinUrl: z.string().url().nullable(),
  source: z.enum(["company_profile", "job_detail"]),
});

export const JobPostingSchema = z.object({
  externalId: z.string(),
  title: z.string().min(1),
  location: z.string().nullable(),
  isRemote: z.boolean(),
  applyUrl: z.string().url(),
  postedAt: z.coerce.date().nullable(),
});

export const CompanySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  pitch: z.string().nullable(),
  size: z.string().nullable(), // texto crudo: "1-10 Employees"
  market: z.string().nullable(),
  websiteUrl: z.string().url().nullable(),
  wellfoundUrl: z.string().url(),
  founders: z.array(FounderSchema).default([]),
  jobs: z.array(JobPostingSchema).default([]),
  extraction: z.object({
    strategy: z.enum(["json_ld", "hydrated_state", "css"]),
    confidence: z.number().min(0).max(1),
    missing: z.array(z.string()).default([]),
  }),
});

// Eventos SSE — ver ARCHITECTURE.md sección 7.1. El documento los define como
// un type TS; acá se modelan también como esquema Zod para que
// jobsradar-web pueda validar en runtime lo que llega por EventSource
// (SseAdapter.ts hoy hace JSON.parse sin validar — este esquema lo habilita).
export const SearchEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    found: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("company.found"),
    company: CompanySchema,
    rank: z.number().int().nonnegative(),
  }),
  z.object({
    // Se publica cuando company-detail/job-detail terminan de enriquecer
    // una empresa ya encontrada (founders/market/websiteUrl) — sin esto, la
    // UI se queda para siempre con los datos parciales del company.found
    // original, aunque la base de datos ya tenga la versión completa (bug
    // real reportado por el usuario, sección 9.1 resultado Fase 11).
    // `company` es el estado ya mergeado que devuelve el repositorio
    // (findCompanyBySlug), no un delta — así el consumidor solo reemplaza,
    // nunca tiene que mergear campo a campo.
    type: z.literal("company.updated"),
    company: CompanySchema,
  }),
  z.object({
    type: z.literal("company.failed"),
    slug: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("paused"),
    reason: z.enum(["blocked", "rate_limited"]),
    resumeAt: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    total: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string().min(1),
  }),
]);

export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>;
export type Founder = z.infer<typeof FounderSchema>;
export type JobPosting = z.infer<typeof JobPostingSchema>;
export type Company = z.infer<typeof CompanySchema>;
export type SearchEvent = z.infer<typeof SearchEventSchema>;
