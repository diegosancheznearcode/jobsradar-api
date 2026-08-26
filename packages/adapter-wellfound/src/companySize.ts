// Solo se confirmó "SIZE_1_10" -> "1-10 Employees" contra un fixture real en
// Fase 0. El resto sigue el mismo patrón evidente (SIZE_<min>_<max|PLUS>) en
// vez de una tabla de valores inventados; si no matchea el patrón, se
// devuelve el enum crudo tal cual — nunca un texto inventado. Compartido
// entre RoleListingParser y CompanyProfileParser (ambos leen `companySize`
// del mismo tipo de nodo Apollo).
export function humanizeCompanySize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^SIZE_(\d+)_(\d+|PLUS)$/);
  if (!match) return raw;
  const [, min, maxToken] = match;
  return maxToken === "PLUS" ? `${min}+ Employees` : `${min}-${maxToken} Employees`;
}
