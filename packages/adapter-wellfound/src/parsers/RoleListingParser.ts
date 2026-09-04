import type { Company, JobPosting } from "@diegosancheznearcode/contracts";
import { CompanySchema } from "@diegosancheznearcode/contracts";
import { err } from "@jobsradar/domain";
import type { ExtractionError, Result } from "@jobsradar/domain";
import { extractWithCascade } from "../cascade.js";
import type { CascadeResult } from "../cascade.js";
import { getApolloState, parseNextData, resolveRef } from "../htmlExtractors.js";
import { humanizeCompanySize } from "../companySize.js";

// /role/r/{rol} -> slugs + name/size/pitch/jobs destacados. Ver
// ARCHITECTURE.md sección 6 y el hallazgo de Fase 0: gana `hydrated_state`
// (Apollo/__NEXT_DATA__); no hay JSON-LD en esta ruta.
//
// El listado NO trae market/websiteUrl/founders/linkedinUrl — quedan en
// null y se listan en extraction.missing, tal como exige la regla de
// nulabilidad de la sección 4.1. `JobSourcePort.listCompanies` (sección 5)
// devuelve estos Company parciales directamente (ampliado en Fase 5 — ver
// ARCHITECTURE.md).

export interface RoleListingPage {
  companies: Company[];
  page: number;
  perPage: number;
  pageCount: number;
  totalStartupCount: number;
  hasMore: boolean;
  // Rol que Wellfound realmente resolvió para esta página (el argumento
  // `role` de la clave de Apollo `seoLandingPageJobSearchResults(...)`), no
  // necesariamente el slug pedido — ver el chequeo en parseRoleListing.
  matchedRole?: string | undefined;
}

// expectedRoleSlug es opcional: quien llama sin él (ej. tests con
// fixtures) se queda con el comportamiento viejo, sin este chequeo.
export function parseRoleListing(
  html: string,
  expectedRoleSlug?: string,
): Result<CascadeResult<RoleListingPage>, ExtractionError> {
  const cascadeResult = extractWithCascade(html, [
    { strategy: "hydrated_state", extract: extractFromHydratedState },
  ]);
  if (!cascadeResult.ok) return cascadeResult;

  // Bug real reportado por el usuario ("ayer funcionaba, hoy no" buscando
  // "Mobile Developer"): Wellfound nunca devuelve 404 para un slug de rol
  // que no reconoce — cae en silencio al catálogo genérico "Remote Tech &
  // Startup Jobs" (miles de empresas de CUALQUIER rol, sin filtrar). La
  // clave de Apollo sí distingue los dos casos: trae `"role":"<slug>"`
  // cuando el rol existe en la taxonomía de Wellfound, y no trae `role` en
  // absoluto cuando cayó al fallback. Sin este chequeo, la app aceptaba ese
  // catálogo genérico como si fueran resultados válidos de la búsqueda.
  if (expectedRoleSlug && cascadeResult.value.data.matchedRole !== expectedRoleSlug) {
    return err({ kind: "not_found", retryable: false });
  }

  return cascadeResult;
}

function extractFromHydratedState(html: string): RoleListingPage | null {
  const nextData = parseNextData(html);
  if (!nextData) return null;

  const apollo = getApolloState(nextData);
  const talent = apollo?.ROOT_QUERY?.talent;
  if (!apollo || !talent) return null;

  const resultsKey = Object.keys(talent).find((k) => k.startsWith("seoLandingPageJobSearchResults("));
  if (!resultsKey) return null;
  const results = talent[resultsKey];

  const { page, role } = parseResultsKeyArgs(resultsKey);
  const perPage: number = results.perPage;
  const pageCount: number = results.pageCount;
  const totalStartupCount: number = results.totalStartupCount;

  const companies: Company[] = (results.startups ?? [])
    .map((ref: { __ref: string }) => resolveRef(apollo, ref))
    .filter((startup: unknown): startup is Record<string, any> => startup !== null)
    .map((startup: Record<string, any>) => toCompany(startup, apollo));

  return {
    companies,
    page,
    perPage,
    pageCount,
    totalStartupCount,
    hasMore: page < pageCount,
    matchedRole: role,
  };
}

function parseResultsKeyArgs(key: string): { page: number; role?: string } {
  const argsMatch = key.match(/\((\{.*\})\)$/);
  if (!argsMatch) return { page: 1 };
  try {
    const args = JSON.parse(argsMatch[1] ?? "{}");
    return {
      page: typeof args.page === "number" ? args.page : 1,
      role: typeof args.role === "string" ? args.role : undefined,
    };
  } catch {
    return { page: 1 };
  }
}

function toCompany(startup: Record<string, any>, apollo: Record<string, any>): Company {
  const jobs: JobPosting[] = (startup.highlightedJobListings ?? [])
    .map((ref: { __ref: string }) => resolveRef(apollo, ref))
    .filter((job: unknown): job is Record<string, any> => job !== null)
    .map(toJobPosting);

  const company = {
    slug: startup.slug,
    name: startup.name,
    pitch: startup.highConcept ?? null,
    size: humanizeCompanySize(startup.companySize),
    market: null,
    websiteUrl: null,
    linkedinUrl: null,
    wellfoundUrl: `https://wellfound.com/company/${startup.slug}`,
    founders: [],
    jobs,
    extraction: {
      strategy: "hydrated_state" as const,
      confidence: 0.6,
      missing: ["market", "websiteUrl", "founders", "linkedinUrl"],
    },
  };

  return CompanySchema.parse(company);
}

function toJobPosting(job: Record<string, any>): JobPosting {
  return {
    externalId: String(job.id),
    title: job.title,
    location: job.locationNames?.length ? job.locationNames.join(", ") : null,
    isRemote: job.remote === true,
    applyUrl: `https://wellfound.com/jobs/${job.id}-${job.slug}`,
    postedAt: typeof job.liveStartAt === "number" ? new Date(job.liveStartAt * 1000) : null,
  };
}
