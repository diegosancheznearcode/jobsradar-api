// Filtra por SearchCriteria.maxCompanySize contra el `size` crudo que ya
// extrae RoleListingParser ("11-50 Employees", "501+ Employees" — ver
// packages/adapter-wellfound/src/companySize.ts). Vive en el worker, no en
// el adapter: es un criterio de búsqueda, no algo que dependa de cómo se
// extrajo el dato.

export function matchesMaxCompanySize(size: string | null, maxCompanySize: number | undefined): boolean {
  if (maxCompanySize === undefined) return true;
  if (size === null) return false;

  const rangeMatch = size.match(/^(\d+)-(\d+)\s+Employees$/);
  if (rangeMatch) {
    const upperBound = Number(rangeMatch[2]);
    return upperBound <= maxCompanySize;
  }

  // "501+ Employees" — sin tope superior, nunca entra en un filtro de máximo.
  const plusMatch = size.match(/^(\d+)\+\s+Employees$/);
  if (plusMatch) return false;

  // Formato inesperado: no se puede confirmar que cumple, se excluye en vez
  // de arriesgar un falso positivo.
  return false;
}
