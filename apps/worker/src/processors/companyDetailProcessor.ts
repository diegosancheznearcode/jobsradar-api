import type { EventPublisherPort, JobSourcePort, SearchRepositoryPort } from "@jobsradar/domain";
import type { CompanyDetailJobData } from "./searchListProcessor.js";

// Cola company-detail — ver ARCHITECTURE.md sección 10. Enriquece una
// empresa ya listada con founders/market/website (requiere sesión, Fase 0).
// El rank pasado a attachCompany se ignora: search-list ya insertó la fila
// real en search_results antes de encolar este job (ON CONFLICT DO
// NOTHING en el repositorio).

const CACHE_MAX_AGE_HOURS = 24 * 7; // una semana — sin TTL real de cf_clearance medido (Fase 4), valor conservador

export interface CompanyDetailDeps {
  adapter: JobSourcePort;
  repository: SearchRepositoryPort;
  events: EventPublisherPort;
  log?: (message: string) => void;
}

export async function processCompanyDetail(data: CompanyDetailJobData, deps: CompanyDetailDeps): Promise<void> {
  const log = deps.log ?? console.error;

  const cached = await deps.repository.findCompanyBySlug(data.slug, CACHE_MAX_AGE_HOURS);
  if (cached && cached.founders.length > 0) {
    // Ya enriquecida y todavía fresca — evita gastar sesión/red de nuevo.
    return;
  }

  const result = await deps.adapter.getCompany(data.slug);
  if (!result.ok) {
    if (result.error.kind === "blocked") {
      log(`[company-detail] slug=${data.slug} blocked — falta sesión válida, renovar storageState.json manualmente`);
      // blocked afecta a toda la búsqueda, no solo a esta empresa (Fase 4:
      // el circuit breaker del adaptador ya frenó al resto de esta cola).
      await deps.repository.updateStatus(data.searchId, "paused");
      await deps.events.publish(data.searchId, {
        type: "paused",
        reason: "blocked",
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
      });
    } else {
      log(`[company-detail] slug=${data.slug} error=${result.error.kind}`);
      await deps.events.publish(data.searchId, {
        type: "company.failed",
        slug: data.slug,
        reason: result.error.kind,
      });
    }
    return;
  }

  await deps.repository.attachCompany(data.searchId, result.value, 0);
}
