import type { Company, SearchCriteria } from "@diegosancheznearcode/contracts";
import { CompanySchema } from "@diegosancheznearcode/contracts";
import { err, ok } from "@jobsradar/domain";
import type { ExtractionError, JobSourcePort, Result } from "@jobsradar/domain";
import type { CircuitBreaker } from "./CircuitBreaker.js";
import type { ExtractionMetrics } from "./ExtractionMetrics.js";
import type { HttpClient } from "./HttpClient.js";
import { parseCompanyProfile } from "./parsers/CompanyProfileParser.js";
import { parseRoleListing } from "./parsers/RoleListingParser.js";
import { buildCompanyProfileUrl, buildRoleListingUrl } from "./urlBuilder.js";

// Implementa JobSourcePort — ver ARCHITECTURE.md sección 6. Orquesta
// HttpClient + parsers + circuit breaker + métricas de extracción; NO
// conoce Playwright/BrowserClient directamente — quien construye el
// adaptador decide cuándo renovar la sesión (ver comentario en getCompany).

export class WellfoundAdapter implements JobSourcePort {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
    private readonly metrics: ExtractionMetrics,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  async listCompanies(
    criteria: SearchCriteria,
    page: number,
  ): Promise<Result<{ companies: Company[]; hasMore: boolean }, ExtractionError>> {
    if (this.breaker.isOpen()) return err(this.breaker.getLastError()!);

    const url = buildRoleListingUrl(criteria, page);
    // El listado no necesita sesión (Fase 0) — withSession queda en false.
    const htmlResult = await this.http.get(url);
    if (!htmlResult.ok) {
      this.tripOnBlock(htmlResult.error);
      return err(htmlResult.error);
    }

    const parsed = parseRoleListing(htmlResult.value);
    this.recordExtraction(parsed);
    if (!parsed.ok) return err(parsed.error);

    const { companies, hasMore } = parsed.value.data;
    return ok({ companies, hasMore });
  }

  async getCompany(slug: string): Promise<Result<Company, ExtractionError>> {
    if (this.breaker.isOpen()) return err(this.breaker.getLastError()!);

    const url = buildCompanyProfileUrl(slug);
    // /company/{slug} sí necesita sesión (Fase 0) — si no hay storageState
    // cargado, HttpClient simplemente no manda Cookie y Wellfound devuelve
    // el challenge (`blocked`), tal como se confirmó en Fase 0.
    const htmlResult = await this.http.get(url, { withSession: true });
    if (!htmlResult.ok) {
      this.tripOnBlock(htmlResult.error);
      return err(htmlResult.error);
    }

    const parsed = parseCompanyProfile(htmlResult.value);
    this.recordExtraction(parsed);
    if (!parsed.ok) {
      this.tripOnBlock(parsed.error);
      return err(parsed.error);
    }

    const p = parsed.value.data;
    // getCompany no trae `jobs` — esos vienen de RoleListingParser
    // (highlightedJobListings) o JobDetailParser; combinarlos con lo que
    // devuelve el perfil es responsabilidad de quien orqueste las 3 fuentes
    // (repositorio/caché, Fase 5), no de este método.
    const company = CompanySchema.parse({
      slug: p.slug,
      name: p.name,
      pitch: p.pitch,
      size: p.size,
      market: p.market,
      websiteUrl: p.websiteUrl,
      linkedinUrl: p.linkedinUrl,
      wellfoundUrl: url,
      founders: p.founders,
      jobs: [],
      extraction: {
        strategy: parsed.value.strategy,
        confidence: p.founders.length > 0 ? 0.9 : 0.7,
        missing: [
          ...(p.founders.length > 0 ? [] : ["founders"]),
          ...(p.linkedinUrl ? [] : ["linkedinUrl"]),
        ],
      },
    });

    return ok(company);
  }

  // "blocked" es la única señal que abre el breaker (AD-09): rate_limited
  // ya se reintenta dentro de HttpClient, not_found/parse_failed son
  // errores de una sola empresa, no del acceso global.
  private tripOnBlock(error: ExtractionError): void {
    if (error.kind === "blocked") this.breaker.trip(error);
  }

  // Fase 8 (sección 11): "extracción vacía" es específicamente
  // parse_failed con un HTML que sí llegó — blocked no cuenta acá, ya lo
  // cubre el circuit breaker; not_found tampoco (no es un selector roto,
  // es que la página no existe).
  private recordExtraction(parsed: Result<unknown, ExtractionError>): void {
    if (parsed.ok) {
      this.metrics.record(true);
    } else if (parsed.error.kind === "parse_failed") {
      this.metrics.record(false);
    } else {
      return;
    }

    if (this.metrics.isAboveThreshold()) {
      const rate = Math.round(this.metrics.failureRate() * 100);
      const breakerState = this.breaker.getMetrics();
      this.log(
        `[extraction-alert] tasa de extracción vacía ${rate}% en las últimas ${this.metrics.sampleSize} extracciones ` +
          `(umbral 30%, sección 11) — revisar selectores. circuit breaker: ${breakerState.state}, ` +
          `abierto ${breakerState.tripCount} veces.`,
      );
    }
  }
}
