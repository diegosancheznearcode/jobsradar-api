import type { SearchCriteria } from "@diegosancheznearcode/contracts";

// Construccion de URL -- ver ARCHITECTURE.md seccion 3. El frontend NO
// simula el formulario; se construye la ruta directamente.
//
// role-slug y location-slug: minusculas, sin acentos, espacios -> "-".

const COMBINING_MARKS = new RegExp("[̀-ͯ]", "g");

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function buildRoleListingUrl(criteria: SearchCriteria, page: number): string {
  const roleSlug = slugify(criteria.jobTitle);

  let base: string;
  if (criteria.remoteOnly) {
    base = `https://wellfound.com/role/r/${roleSlug}`;
  } else if (criteria.location) {
    base = `https://wellfound.com/role/l/${roleSlug}/${slugify(criteria.location)}`;
  } else {
    base = `https://wellfound.com/role/${roleSlug}`;
  }

  return page > 1 ? `${base}?page=${page}` : base;
}

export function buildCompanyProfileUrl(slug: string): string {
  return `https://wellfound.com/company/${slug}`;
}
