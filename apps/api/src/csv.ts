import type { Company } from "@diegosancheznearcode/contracts";

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
  "wellfoundUrl",
  "founders",
  "jobTitles",
  "applyUrls",
] as const;

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function companiesToCsv(companies: Company[]): string {
  const header = COLUMNS.join(",");
  const rows = companies.map((company) => {
    const founders = company.founders.map((f) => (f.role ? `${f.name} (${f.role})` : f.name)).join("; ");
    const jobTitles = company.jobs.map((j) => j.title).join("; ");
    const applyUrls = company.jobs.map((j) => j.applyUrl).join("; ");

    const row: Record<(typeof COLUMNS)[number], string> = {
      slug: company.slug,
      name: company.name,
      pitch: company.pitch ?? "",
      size: company.size ?? "",
      market: company.market ?? "",
      websiteUrl: company.websiteUrl ?? "",
      wellfoundUrl: company.wellfoundUrl,
      founders,
      jobTitles,
      applyUrls,
    };

    return COLUMNS.map((col) => escapeCsvField(row[col])).join(",");
  });

  return [header, ...rows].join("\n") + "\n";
}
