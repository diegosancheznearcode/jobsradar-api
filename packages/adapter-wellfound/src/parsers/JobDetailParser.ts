import type { JobPosting } from "@jobsradar/contracts";
import { JobPostingSchema } from "@jobsradar/contracts";
import type { ExtractionError, Result } from "@jobsradar/domain";
import { extractWithCascade } from "../cascade.js";
import type { CascadeResult } from "../cascade.js";
import { getCanonicalUrl, parseJsonLd } from "../htmlExtractors.js";

// /jobs/{id} -> JobPosting + market/websiteUrl de la empresa. Ver
// ARCHITECTURE.md sección 6 y el hallazgo de Fase 0: gana `json_ld`; esta
// ruta no tiene __NEXT_DATA__ (a diferencia del listado y el perfil).

export interface JobDetailResult {
  job: JobPosting;
  company: {
    name: string;
    market: string | null;
    websiteUrl: string | null;
  };
}

export function parseJobDetail(
  html: string,
): Result<CascadeResult<JobDetailResult>, ExtractionError> {
  return extractWithCascade(html, [
    { strategy: "json_ld", extract: (h) => extractFromJsonLd(h) },
  ]);
}

function extractFromJsonLd(html: string): JobDetailResult | null {
  const ld = parseJsonLd(html) as Record<string, any> | null;
  if (!ld || ld["@type"] !== "JobPosting") return null;

  const applyUrl = getCanonicalUrl(html) ?? undefined;
  if (!applyUrl) return null;

  const jobLocation = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : null;
  const address = jobLocation?.address;
  const location = address
    ? [address.addressLocality, address.addressRegion].filter(Boolean).join(", ") || null
    : null;

  const job: JobPosting = JobPostingSchema.parse({
    externalId: ld.identifier?.value ?? extractIdFromCanonical(applyUrl),
    title: ld.title,
    location,
    isRemote: ld.jobLocationType === "TELECOMMUTE",
    applyUrl,
    postedAt: ld.datePosted ?? null,
  });

  return {
    job,
    company: {
      name: ld.hiringOrganization?.name ?? ld.title,
      market: ld.industry ?? null,
      websiteUrl: ld.hiringOrganization?.sameAs ?? null,
    },
  };
}

function extractIdFromCanonical(url: string): string {
  const match = url.match(/\/jobs\/([^/?#]+)/);
  return match?.[1] ?? url;
}
