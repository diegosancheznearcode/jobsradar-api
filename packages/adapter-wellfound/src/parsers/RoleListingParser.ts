import type { Company, JobPosting } from "@jobsradar/contracts";
import { CompanySchema } from "@jobsradar/contracts";
import type { ExtractionError, Result } from "@jobsradar/domain";
import { extractWithCascade } from "../cascade.js";
import type { CascadeResult } from "../cascade.js";
import { getApolloState, parseNextData, resolveRef } from "../htmlExtractors.js";
import { humanizeCompanySize } from "../companySize.js";

// /role/r/{rol} -> slugs + name/size/pitch/jobs destacados. Ver
// ARCHITECTURE.md sección 6 y el hallazgo de Fase 0: gana `hydrated_state`
// (Apollo/__NEXT_DATA__); no hay JSON-LD en esta ruta.
//
// El listado NO trae market/websiteUrl/founders — quedan en null y se
// listan en extraction.missing, tal como exige la regla de nulabilidad de
// la sección 4.1. `JobSourcePort.listCompanies` (sección 5) devuelve estos
// Company parciales directamente (ampliado en Fase 5 — ver ARCHITECTURE.md).

export interface RoleListingPage {
  companies: Company[];
  page: number;
  perPage: number;
  pageCount: number;
  totalStartupCount: number;
  hasMore: boolean;
}

export function parseRoleListing(
  html: string,
): Result<CascadeResult<RoleListingPage>, ExtractionError> {
  return extractWithCascade(html, [
    { strategy: "hydrated_state", extract: extractFromHydratedState },
  ]);
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

  const page = extractPageFromKey(resultsKey);
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
  };
}

function extractPageFromKey(key: string): number {
  const argsMatch = key.match(/\((\{.*\})\)$/);
  if (!argsMatch) return 1;
  try {
    const args = JSON.parse(argsMatch[1] ?? "{}");
    return typeof args.page === "number" ? args.page : 1;
  } catch {
    return 1;
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
    wellfoundUrl: `https://wellfound.com/company/${startup.slug}`,
    founders: [],
    jobs,
    extraction: {
      strategy: "hydrated_state" as const,
      confidence: 0.6,
      missing: ["market", "websiteUrl", "founders"],
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
