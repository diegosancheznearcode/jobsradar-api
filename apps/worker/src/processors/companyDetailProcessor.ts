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

// Pedido explícito del usuario ("el spinner no se puede dejar hasta que
// cargue todo") — ver el comentario en SearchRepositoryPort. Se llama al
// terminar CUALQUIER intento resuelto (éxito, cache-hit, o error que no
// sea "blocked" — ver abajo por qué "blocked" queda afuera). Publica
// "enrichment.done" solo si además el listado ya es terminal ("done"):
// mientras el listado siga corriendo, puede faltar encolar más
// company-detail todavía, así que llegar a enqueued===completed acá no
// significa "no queda nada más" — search-list hace su propio chequeo
// equivalente al terminar (ver searchListProcessor.ts), para el caso donde
// el enriquecimiento se adelanta y termina antes que el listado.
async function finishEnrichmentAttempt(searchId: string, deps: CompanyDetailDeps): Promise<void> {
  const { enqueued, completed } = await deps.repository.recordCompanyDetailCompleted(searchId);
  if (completed < enqueued) return;
  const status = await deps.repository.getStatus(searchId);
  if (status !== "done") return;
  await deps.events.publish(searchId, { type: "enrichment.done" });
}

export async function processCompanyDetail(data: CompanyDetailJobData, deps: CompanyDetailDeps): Promise<void> {
  const log = deps.log ?? console.error;

  const cached = await deps.repository.findCompanyBySlug(data.slug, CACHE_MAX_AGE_HOURS);
  if (cached && cached.founders.length > 0) {
    // Ya enriquecida y todavía fresca — evita gastar sesión/red de nuevo.
    // Igual cuenta como "intento resuelto": search-list SÍ contó este slug
    // como encolado (recordCompanyDetailEnqueued), así que sin este
    // contrapeso el conteo quedaría descuadrado para siempre y
    // "enrichment.done" nunca se publicaría.
    await finishEnrichmentAttempt(data.searchId, deps);
    return;
  }

  const result = await deps.adapter.getCompany(data.slug);
  if (!result.ok) {
    if (result.error.kind === "blocked") {
      log(`[company-detail] slug=${data.slug} blocked — falta sesión válida, renovar storageState.json manualmente`);
      // blocked afecta a toda la búsqueda, no solo a esta empresa (Fase 4:
      // el circuit breaker del adaptador ya frenó al resto de esta cola).
      // NO cuenta como completado a propósito: no hubo resolución real,
      // hay que reintentar. Como esto pausa toda la búsqueda, el spinner
      // igual deja de mostrarse (status "paused" ≠ "running"/"done" en
      // App.tsx) sin depender de que este contador cierre.
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
      await finishEnrichmentAttempt(data.searchId, deps);
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

  await finishEnrichmentAttempt(data.searchId, deps);
}
