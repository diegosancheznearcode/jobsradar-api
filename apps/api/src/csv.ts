import type { Company } from "@nearcodecr/jobsradar-contracts";

// Exportación CSV — ver ARCHITECTURE.md sección 7. Sin librería externa:
// es un formato simple y el proyecto ya evita dependencias innecesarias
// (AD-07, en el mismo espíritu).

const COLUMNS = [
  "slug",
  "name",
  "pitch",
  "size",
  "market",
  "websiteUrl",
  "linkedinUrl",
  "wellfoundUrl",
  "founders",
  "jobTitles",
  "postedDates",
  "applyUrls",
] as const;

// Nombre interno (clave del objeto row, en inglés — así queda) vs. el
// encabezado real de la columna en el CSV, en español (pedido explícito
// del usuario). Separado del array COLUMNS de arriba a propósito: ese
// array sigue siendo la lista de claves que usa el resto de la función.
const COLUMN_LABELS: Record<(typeof COLUMNS)[number], string> = {
  slug: "Identificador",
  name: "Empresa",
  pitch: "Descripción",
  size: "Tamaño",
  market: "Mercado",
  websiteUrl: "Sitio web",
  linkedinUrl: "LinkedIn",
  wellfoundUrl: "URL de Wellfound",
  founders: "Fundadores",
  jobTitles: "Roles",
  postedDates: "Fecha de publicación",
  applyUrls: "URLs de postulación",
};

// Mismo criterio que el filtro de ubicación client-side de ResultsTable
// (jobsradar-web) — substring case-insensitive contra job.location. Vive acá
// (no en un paquete compartido) porque es la única otra vez que se necesita
// esta lógica; si aparece una tercera, ahí sí vale la pena compartirla.
export function filterCompaniesByLocation(companies: Company[], location: string | undefined): Company[] {
  const needle = location?.trim().toLowerCase();
  if (!needle) return companies;
  return companies.filter((company) =>
    company.jobs.some((job) => job.location?.toLowerCase().includes(needle)),
  );
}

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function companiesToCsv(companies: Company[]): string {
  const header = COLUMNS.map((col) => COLUMN_LABELS[col]).join(",");
  const rows = companies.map((company) => {
    const founders = company.founders.map((f) => (f.role ? `${f.name} (${f.role})` : f.name)).join("; ");
    const jobTitles = company.jobs.map((j) => j.title).join("; ");
    // Mismo orden que jobTitles/applyUrls (uno por job, por índice) — un job
    // sin fecha deja el hueco vacío en vez de correr el resto de la lista.
    const postedDates = company.jobs.map((j) => (j.postedAt ? j.postedAt.toISOString().slice(0, 10) : "")).join("; ");
    const applyUrls = company.jobs.map((j) => j.applyUrl).join("; ");

    const row: Record<(typeof COLUMNS)[number], string> = {
      slug: company.slug,
      name: company.name,
      pitch: company.pitch ?? "",
      size: company.size ?? "",
      market: company.market ?? "",
      websiteUrl: company.websiteUrl ?? "",
      linkedinUrl: company.linkedinUrl ?? "",
      wellfoundUrl: company.wellfoundUrl,
      founders,
      jobTitles,
      postedDates,
      applyUrls,
    };

    return COLUMNS.map((col) => escapeCsvField(row[col])).join(",");
  });

  // BOM UTF-8 al inicio — sin esto, Excel (sobre todo en Windows con
  // locale es-*) puede abrir el archivo asumiendo una codificación
  // distinta y romper los acentos ("Método" -> "MÃ©todo"), o directamente
  // no reconocer bien la primera fila como encabezado al abrir con doble
  // clic. No afecta a otros lectores de CSV (Google Sheets, pandas, etc.),
  // que lo ignoran.
  const BOM = "﻿";
  return BOM + [header, ...rows].join("\n") + "\n";
}
