import { CompanySchema } from "@diegosancheznearcode/contracts";
import type { EventPublisherPort, ExtractionError, Result, SearchRepositoryPort } from "@jobsradar/domain";
import type { CascadeResult, JobDetailResult } from "@jobsradar/adapter-wellfound";

// Cola job-detail — ver ARCHITECTURE.md sección 10. GET /jobs/{id}, SIN
// sesión (Fase 0) — es la vía alternativa para market/website cuando
// todavía no hay sesión válida para company-detail, o para confirmarlos
// de forma redundante. JobDetailParser no está detrás de JobSourcePort
// (el puerto solo define listCompanies/getCompany) — este processor
// depende de @jobsradar/adapter-wellfound directamente para esto,
// consistente con lo documentado en ARCHITECTURE.md sección 9.

export interface JobDetailJobData {
  searchId: string;
  slug: string;
  jobUrl: string;
}

export interface JobDetailDeps {
  fetchJobDetail: (url: string) => Promise<Result<CascadeResult<JobDetailResult>, ExtractionError>>;
  repository: SearchRepositoryPort;
  events: EventPublisherPort;
  log?: (message: string) => void;
}

export async function processJobDetail(data: JobDetailJobData, deps: JobDetailDeps): Promise<void> {
  const log = deps.log ?? console.error;

  const result = await deps.fetchJobDetail(data.jobUrl);
  if (!result.ok) {
    log(`[job-detail] slug=${data.slug} url=${data.jobUrl} error=${result.error.kind}`);
    await deps.events.publish(data.searchId, { type: "company.failed", slug: data.slug, reason: result.error.kind });
    return;
  }

  const { company } = result.value.data;
  const partial = CompanySchema.parse({
    slug: data.slug,
    name: company.name,
    pitch: null,
    size: null,
    market: company.market,
    websiteUrl: company.websiteUrl,
    // /jobs/{id} (JSON-LD) no trae LinkedIn de la empresa — solo el perfil
    // (CompanyProfileParser) lo tiene.
    linkedinUrl: null,
    wellfoundUrl: `https://wellfound.com/company/${data.slug}`,
    founders: [],
    jobs: [],
    extraction: {
      strategy: result.value.strategy,
      confidence: 0.5,
      missing: ["pitch", "size", "founders", "linkedinUrl"],
    },
  });

  // rank se ignora, igual que en company-detail: search-list ya insertó
  // la fila real en search_results.
  await deps.repository.attachCompany(data.searchId, partial, 0);

  // Mismo fix que company-detail (sección 9.1 resultado Fase 11): sin esto
  // la UI nunca se entera del market/websiteUrl que este processor acaba de
  // enriquecer. Se re-lee del repositorio, no se publica `partial` directo
  // — attachCompany ya mergeó de forma no destructiva contra lo que había.
  const updated = await deps.repository.findCompanyBySlug(data.slug, 24 * 7);
  if (updated) {
    await deps.events.publish(data.searchId, { type: "company.updated", company: updated });
  }
}
