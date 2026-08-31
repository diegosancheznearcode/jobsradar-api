import type { SearchCriteria } from "@diegosancheznearcode/contracts";
import type { EventPublisherPort, JobSourcePort, SearchRepositoryPort } from "@jobsradar/domain";
import { matchesMaxCompanySize } from "../companySizeFilter.js";

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
  // Tope de páginas por búsqueda — perPage confirmado en Fase 0 es 20, así
  // que targetCompanies=50 necesita ~3 páginas en el caso normal; 10 da
  // margen generoso para roles con mucho descarte/duplicado sin arriesgar
  // una búsqueda que pagina indefinidamente si hasMore nunca baja a false.
  maxPages?: number;
  log?: (message: string) => void;
}

const DEFAULT_MAX_PAGES = 10;

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

  const { companies: allCompanies, hasMore } = listResult.value;
  // maxCompanySize descarta acá, antes de persistir/contar/encolar — así
  // target_companies cuenta empresas que sí cumplen el filtro, no "primeras
  // 50 encontradas y después filtradas" (eso hubiera devuelto muchas menos
  // de las pedidas). Encontrado probando la UI real (Fase 10).
  const companies = allCompanies.filter((company) => matchesMaxCompanySize(company.size, data.criteria.maxCompanySize));

  const before = await deps.repository.getSnapshot(data.searchId);
  let rank = before.progress.found;

  // Wellfound puede repetir una empresa entre páginas del listado
  // (paginación no perfectamente estable) — sin este chequeo, se
  // re-publicaba company.found (duplicaba filas en la UI, bug real: React
  // tiraba "two children with the same key") y se re-encolaba
  // company-detail de más para una empresa que ya se estaba/había
  // enriquecido. `search_results` ya es idempotente por (searchId, slug)
  // a nivel SQL — esto evita el trabajo/ruido de más antes de llegar ahí.
  const alreadyFound = new Set(before.companies.map((c) => c.slug));

  for (const company of companies) {
    if (alreadyFound.has(company.slug)) continue;
    alreadyFound.add(company.slug);

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

  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  if (hasMore && after.progress.found < after.progress.target) {
    if (data.page < maxPages) {
      await deps.enqueueNextPage({ searchId: data.searchId, criteria: data.criteria, page: data.page + 1 });
      return;
    }
    log(`[search-list] searchId=${data.searchId} llegó al tope de ${maxPages} páginas, cierra parcial`);
  }

  // Termina la fase de listado. Los company-detail/job-detail ya encolados
  // pueden seguir enriqueciendo empresas en segundo plano — "done" acá
  // significa "el listado terminó", no "toda la enriquecida terminó". Ver
  // ARCHITECTURE.md sección 10 resultado de Fase 6 para esta simplificación.
  await deps.repository.updateStatus(data.searchId, "done");
  const partial = after.companies.filter((c) => c.extraction.missing.length > 0).length;
  await deps.events.publish(data.searchId, { type: "done", total: after.progress.found, partial });
}
