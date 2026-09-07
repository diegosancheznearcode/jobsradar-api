import type { EventPublisherPort, JobSourcePort, SearchRepositoryPort } from "@jobsradar/domain";
import type { CompanyDetailJobData } from "./searchListProcessor.js";

// Cola company-detail — ver ARCHITECTURE.md sección 10. Enriquece una
// empresa ya listada con founders/market/website (requiere sesión, Fase 0).
// El rank pasado a attachCompany se ignora: search-list ya insertó la fila
// real en search_results antes de encolar este job (ON CONFLICT DO
// NOTHING en el repositorio).

const CACHE_MAX_AGE_HOURS = 24 * 7; // una semana — sin TTL real de cf_clearance medido (Fase 4), valor conservador

// Pedido explícito del usuario: cuando Wellfound no trae linkedinUrl de una
// empresa (CompanyProfileParser, Fase 0: /company/{slug}/people no lo
// expone), se completa con el servicio propio del usuario en
// linkedinLookupClient.ts. Es opcional en deps — sin él, o si no encuentra
// nada, la empresa se guarda igual sin linkedinUrl, como pasaba antes.
export interface LinkedinLookupPort {
  findLinkedinUrl(websiteUrl: string): Promise<string | null>;
}

export interface CompanyDetailDeps {
  adapter: JobSourcePort;
  repository: SearchRepositoryPort;
  events: EventPublisherPort;
  linkedinLookup?: LinkedinLookupPort | undefined;
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

  let company = result.value;
  if (!company.linkedinUrl && company.websiteUrl && deps.linkedinLookup) {
    const linkedinUrl = await deps.linkedinLookup.findLinkedinUrl(company.websiteUrl);
    if (linkedinUrl) {
      company = {
        ...company,
        linkedinUrl,
        extraction: {
          ...company.extraction,
          missing: company.extraction.missing.filter((field) => field !== "linkedinUrl"),
        },
      };
    }
  }

  await deps.repository.attachCompany(data.searchId, company, 0);

  // Sin esto, la UI nunca se entera de que esta empresa ya tiene
  // founders/market/website: se queda para siempre con los datos parciales
  // del company.found original (bug real, sección 9.1 resultado Fase 11).
  // Se re-lee del repositorio en vez de publicar result.value directo:
  // attachCompany mergea de forma no destructiva (COALESCE) contra lo que
  // ya había, así que lo que hay que mandar es ese estado ya mergeado, no
  // lo que trajo este fetch en particular.
  const updated = await deps.repository.findCompanyBySlug(data.slug, CACHE_MAX_AGE_HOURS);
  if (updated) {
    await deps.events.publish(data.searchId, { type: "company.updated", company: updated });
  }
}
