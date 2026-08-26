import { describe, expect, it } from "vitest";
import { buildCompanyProfileUrl, buildRoleListingUrl, slugify } from "./urlBuilder.js";

describe("slugify", () => {
  it("minúsculas, espacios a guiones, sin acentos", () => {
    expect(slugify("Diseño de Producto")).toBe("diseno-de-producto");
    expect(slugify("Backend Engineer")).toBe("backend-engineer");
    expect(slugify("Ingeniería de Software")).toBe("ingenieria-de-software");
  });
});

describe("buildRoleListingUrl", () => {
  it("remote=true -> /role/r/{role-slug}", () => {
    const url = buildRoleListingUrl(
      { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 },
      1,
    );
    expect(url).toBe("https://wellfound.com/role/r/backend-engineer");
  });

  it("remote=false + location -> /role/l/{role-slug}/{location-slug}", () => {
    const url = buildRoleListingUrl(
      { jobTitle: "Backend Engineer", location: "Bogotá", remoteOnly: false, targetCompanies: 50 },
      1,
    );
    expect(url).toBe("https://wellfound.com/role/l/backend-engineer/bogota");
  });

  it("sin filtros -> /role/{role-slug}", () => {
    const url = buildRoleListingUrl(
      { jobTitle: "Backend Engineer", remoteOnly: false, targetCompanies: 50 },
      1,
    );
    expect(url).toBe("https://wellfound.com/role/backend-engineer");
  });

  it("agrega ?page=N solo si page > 1 (confirmado en Fase 0)", () => {
    const page1 = buildRoleListingUrl(
      { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 },
      1,
    );
    const page2 = buildRoleListingUrl(
      { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 },
      2,
    );
    expect(page1).not.toContain("?page=");
    expect(page2).toBe("https://wellfound.com/role/r/backend-engineer?page=2");
  });
});

describe("buildCompanyProfileUrl", () => {
  it("construye /company/{slug}", () => {
    expect(buildCompanyProfileUrl("vaulfi-1")).toBe("https://wellfound.com/company/vaulfi-1");
  });
});
