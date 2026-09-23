import { describe, expect, it } from "vitest";
import type { Company } from "@nearcodecr/jobsradar-contracts";
import { companiesToCsv, filterCompaniesByLocation } from "./csv.js";

function company(slug: string, jobLocations: (string | null)[]): Company {
  return {
    slug,
    name: slug,
    pitch: null,
    size: null,
    market: null,
    websiteUrl: null,
    linkedinUrl: null,
    wellfoundUrl: `https://wellfound.com/company/${slug}`,
    founders: [],
    jobs: jobLocations.map((location, i) => ({
      externalId: String(i),
      title: "Backend Engineer",
      location,
      isRemote: true,
      applyUrl: `https://wellfound.com/jobs/${i}`,
      postedAt: null,
    })),
    extraction: { strategy: "hydrated_state", confidence: 0.6, missing: [] },
  };
}

describe("filterCompaniesByLocation", () => {
  it("sin location, devuelve todas las empresas sin tocar (mismo comportamiento que antes del filtro)", () => {
    const companies = [company("a", ["San Mateo"]), company("b", ["New York City"])];
    expect(filterCompaniesByLocation(companies, undefined)).toEqual(companies);
  });

  it("filtra por substring, case-insensitive, contra el location de cualquiera de sus jobs", () => {
    const companies = [company("a", ["San Mateo"]), company("b", ["New York City"])];
    const result = filterCompaniesByLocation(companies, "san mateo");
    expect(result.map((c) => c.slug)).toEqual(["a"]);
  });

  it("una empresa sin ningún job con location matcheable queda afuera", () => {
    const companies = [company("a", [null]), company("b", ["San Mateo"])];
    expect(filterCompaniesByLocation(companies, "san mateo").map((c) => c.slug)).toEqual(["b"]);
  });
});

describe("companiesToCsv", () => {
  it("incluye postedDates como fecha ISO (YYYY-MM-DD), un valor por job en el mismo orden que jobTitles", () => {
    const withDates: Company = {
      ...company("a", ["San Mateo"]),
      jobs: [
        { ...company("a", ["San Mateo"]).jobs[0]!, title: "Backend Engineer", postedAt: new Date("2026-08-27T17:45:44Z") },
        { ...company("a", ["San Mateo"]).jobs[0]!, title: "Frontend Engineer", postedAt: null },
      ],
    };

    const csv = companiesToCsv([withDates]);

    expect(csv).toContain("Fecha de publicación");
    expect(csv).toContain("2026-08-27; ");
  });

  it("los encabezados están en español, no los nombres internos en inglés", () => {
    // Bug real reportado por el usuario: al abrir el CSV en Excel, salían
    // "Column1, Column2..." en vez de nombres legibles — el problema real
    // era que quería los encabezados en español, no en el inglés interno
    // (slug, name, websiteUrl...) que se usaba antes.
    const csv = companiesToCsv([company("a", ["San Mateo"])]);
    const header = csv.split("\n")[0]!;

    expect(header).toContain("Empresa");
    expect(header).toContain("Tamaño");
    expect(header).toContain("Sitio web");
    expect(header).toContain("Fundadores");
    expect(header).toContain("LinkedIn");
    expect(header).not.toContain("websiteUrl");
    expect(header).not.toContain("jobTitles");
  });

  it("incluye la URL de LinkedIn de la empresa (no de un founder)", () => {
    // Pedido explícito del usuario, viendo el ícono de LinkedIn junto al
    // Website en la página real de Wellfound — ese dato es de la EMPRESA,
    // no de un founder puntual (sección 9.1 resultado Fase 11).
    const withLinkedin: Company = {
      ...company("a", ["San Mateo"]),
      linkedinUrl: "https://www.linkedin.com/company/vaulfi",
    };

    const csv = companiesToCsv([withLinkedin]);

    expect(csv).toContain("https://www.linkedin.com/company/vaulfi");
  });

  it("empieza con un BOM UTF-8, para que Excel abra los acentos bien al hacer doble clic", () => {
    const csv = companiesToCsv([company("a", ["San Mateo"])]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
});
