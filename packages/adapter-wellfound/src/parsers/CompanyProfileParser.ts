import type { Founder } from "@jobsradar/contracts";
import { FounderSchema } from "@jobsradar/contracts";
import { err } from "@jobsradar/domain";
import type { ExtractionError, Result } from "@jobsradar/domain";
import { extractWithCascade, isCloudflareChallenge } from "../cascade.js";
import type { CascadeResult } from "../cascade.js";
import { getApolloState, parseNextData, resolveRef } from "../htmlExtractors.js";

// /company/{slug} (o /company/{slug}/people) -> founders + market/website.
// Ver ARCHITECTURE.md sección 6 y el hallazgo de Fase 0: gana
// `hydrated_state`, pero solo con sesión autenticada — sin ella, Cloudflare
// devuelve un challenge que hay que reconocer como `blocked`, no
// `parse_failed` (sección 6.1, AD-09).

export interface CompanyProfileResult {
  founders: Founder[];
  market: string | null;
  websiteUrl: string | null;
}

export function parseCompanyProfile(
  html: string,
): Result<CascadeResult<CompanyProfileResult>, ExtractionError> {
  if (isCloudflareChallenge(html)) {
    return err({
      kind: "blocked",
      retryable: true,
      detail: "Cloudflare challenge (Cf-Mitigated) — falta sesión con cf_clearance vigente",
    });
  }

  return extractWithCascade(html, [
    { strategy: "hydrated_state", extract: extractFromHydratedState },
  ]);
}

function extractFromHydratedState(html: string): CompanyProfileResult | null {
  const nextData = parseNextData(html);
  if (!nextData) return null;

  const apollo = getApolloState(nextData);
  if (!apollo) return null;

  // El perfil puede incluir Startups "recomendadas" como stubs mínimos
  // (sin currentFounderRoles/companyUrl) — el nodo principal es el único
  // con esos campos. Ver Fase 0.
  const startupKey = Object.keys(apollo).find(
    (k) => k.startsWith("Startup:") && "currentFounderRoles" in apollo[k],
  );
  if (!startupKey) return null;
  const startup = apollo[startupKey];

  const founders: Founder[] = (startup.currentFounderRoles ?? [])
    .map((ref: { __ref: string }) => resolveRef(apollo, ref))
    .filter((role: unknown): role is Record<string, any> => role !== null)
    .map((role: Record<string, any>) => toFounder(role, apollo))
    .filter((founder: Founder | null): founder is Founder => founder !== null);

  const market: string | null = (startup.marketTaggings ?? [])
    .map((ref: { __ref: string }) => resolveRef(apollo, ref))
    .filter((tag: unknown): tag is Record<string, any> => tag !== null)
    .map((tag: Record<string, any>) => tag.displayName)
    .filter(Boolean)
    .join(", ") || null;

  return {
    founders,
    market,
    websiteUrl: startup.companyUrl ?? null,
  };
}

function toFounder(role: Record<string, any>, apollo: Record<string, any>): Founder | null {
  const user = resolveRef(apollo, role.user);
  if (!user) return null;

  // linkedinUrl: no se observó ese campo en esta query en Fase 0 — queda
  // null (regla de nulabilidad), no un valor inventado.
  return FounderSchema.parse({
    name: user.name,
    role: role.title ?? null,
    profileUrl: user.pathName ? `https://wellfound.com${user.pathName}` : null,
    linkedinUrl: null,
    source: "company_profile",
  });
}
