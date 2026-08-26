import type { Company, SearchCriteria, SearchEvent } from "@jobsradar/contracts";
import type { ExtractionError, Result } from "./result.js";

// Puertos — ver ARCHITECTURE.md sección 5.

export interface JobSourcePort {
  // El documento (sección 5) define esto como { slugs, hasMore } — se
  // amplió a Company[] en Fase 5: el listado ya trae nombre/pitch/tamaño/
  // roles destacados sin sesión (Fase 0), y `slug` ya es un campo de
  // Company, así que no se pierde nada. Devolver solo slugs obligaba a
  // pedir /company/{slug} (con sesión) de nuevo para datos que ya se
  // tenían gratis.
  listCompanies(
    criteria: SearchCriteria,
    page: number,
  ): Promise<Result<{ companies: Company[]; hasMore: boolean }, ExtractionError>>;

  getCompany(slug: string): Promise<Result<Company, ExtractionError>>;
}

// El documento usa `SearchSnapshot` en SearchRepositoryPort.getSnapshot sin
// definirlo aparte. Se deriva de la sección 7 (`GET /api/searches/:id ->
// { status, progress, companies[] }`) y de los valores de `searches.status`
// en el esquema SQL de la sección 8.
export interface SearchSnapshot {
  status: "queued" | "running" | "paused" | "done" | "failed";
  progress: { found: number; target: number; page: number };
  companies: Company[];
}

export interface SearchRepositoryPort {
  create(criteria: SearchCriteria): Promise<string>; // searchId
  attachCompany(searchId: string, company: Company, rank: number): Promise<void>;
  findCompanyBySlug(slug: string, maxAgeHours: number): Promise<Company | null>;
  getSnapshot(searchId: string): Promise<SearchSnapshot>;
}

export interface EventPublisherPort {
  publish(searchId: string, event: SearchEvent): Promise<void>;
}
