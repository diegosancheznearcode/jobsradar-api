import type { SearchCriteria } from "@jobsradar/contracts";
import type { EventPublisherPort, JobSourcePort, SearchRepositoryPort } from "@jobsradar/domain";

// Cola search-list — ver ARCHITECTURE.md sección 10. Pagina /role/r/{rol}
// hasta juntar targetCompanies, encolando company-detail por cada empresa
// nueva. rank se deriva del snapshot actual (progress.found), no de un
// contador aparte — concurrencia 1 en esta cola evita la carrera.

export interface SearchListJobData {
  searchId: string;
  criteria: SearchCriteria;
  page: number;
}

export interface CompanyDetailJobData {
  searchId: string;
  slug: string;
}

export interface SearchListDeps {
  adapter: JobSourcePort;
  repository: SearchRepositoryPort;
  events: EventPublisherPort;
  enqueueCompanyDetail: (data: CompanyDetailJobData) => Promise<void>;
  enqueueNextPage: (data: SearchListJobData) => Promise<void>;
  log?: (message: string) => void;
}

export async function processSearchList(data: SearchListJobData, deps: SearchListDeps): Promise<void> {
  const log = deps.log ?? console.error;
  await deps.repository.updateStatus(data.searchId, "running");

  const listResult = await deps.adapter.listCompanies(data.criteria, data.page);

  if (!listResult.ok) {
    // blocked/rate_limited/parse_failed en el listado: esta búsqueda queda
    // parcial en esta página. No se reencola sola — reintentar contra un
    // bloqueo persistente no la resuelve (AD-09), y sección 1.3 pide
    // degradar sin fallar, no reintentar indefinidamente.
    log(`[search-list] searchId=${data.searchId} page=${data.page} error=${listResult.error.kind}`);

    if (listResult.error.kind === "blocked" || listResult.error.kind === "rate_limited") {
      await deps.repository.updateStatus(data.searchId, "paused");
      await deps.events.publish(data.searchId, {
        type: "paused",
        reason: listResult.error.kind,
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
      });
    } else {
      await deps.repository.updateStatus(data.searchId, "failed");
      await deps.events.publish(data.searchId, { type: "error", message: `listado falló: ${listResult.error.kind}` });
    }
    return;
  }

  const { companies, hasMore } = listResult.value;
  const before = await deps.repository.getSnapshot(data.searchId);
  let rank = before.progress.found;

  for (const company of companies) {
    rank += 1;
    await deps.repository.attachCompany(data.searchId, company, rank);
    await deps.events.publish(data.searchId, { type: "company.found", company, rank });
    await deps.enqueueCompanyDetail({ searchId: data.searchId, slug: company.slug });
  }

  const after = await deps.repository.getSnapshot(data.searchId);
  await deps.events.publish(data.searchId, {
    type: "progress",
    found: after.progress.found,
    target: after.progress.target,
    page: data.page,
  });

  if (hasMore && after.progress.found < after.progress.target) {
    await deps.enqueueNextPage({ searchId: data.searchId, criteria: data.criteria, page: data.page + 1 });
    return;
  }

  // Termina la fase de listado. Los company-detail/job-detail ya encolados
  // pueden seguir enriqueciendo empresas en segundo plano — "done" acá
  // significa "el listado terminó", no "toda la enriquecida terminó". Ver
  // ARCHITECTURE.md sección 10 resultado de Fase 6 para esta simplificación.
  await deps.repository.updateStatus(data.searchId, "done");
  const partial = after.companies.filter((c) => c.extraction.missing.length > 0).length;
  await deps.events.publish(data.searchId, { type: "done", total: after.progress.found, partial });
}
