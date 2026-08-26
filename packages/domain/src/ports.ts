import type { Company, SearchCriteria, SearchEvent } from "@jobsradar/contracts";
import type { ExtractionError, Result } from "./result.js";

// Puertos — ver ARCHITECTURE.md sección 5.

export interface JobSourcePort {
  listCompanies(
    criteria: SearchCriteria,
    page: number,
  ): Promise<Result<{ slugs: string[]; hasMore: boolean }, ExtractionError>>;

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
