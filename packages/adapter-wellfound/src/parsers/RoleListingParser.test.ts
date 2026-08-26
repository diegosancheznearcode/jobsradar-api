import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoleListing } from "./RoleListingParser.js";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
const roleListingHtml = readFileSync(join(fixturesDir, "role-listing.html"), "utf-8");

describe("parseRoleListing", () => {
  it("gana con hydrated_state contra el fixture real (sin red)", () => {
    const result = parseRoleListing(roleListingHtml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.strategy).toBe("hydrated_state");
    }
  });

  it("extrae la paginación confirmada en Fase 0 (perPage 20, page 1, pageCount 38)", () => {
    const result = parseRoleListing(roleListingHtml);
    if (!result.ok) throw new Error("unreachable");
    const page = result.value.data;
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
    expect(page.pageCount).toBe(38);
    expect(page.totalStartupCount).toBe(747);
    expect(page.hasMore).toBe(true);
  });

  it("cada empresa valida contra CompanySchema, con market/websiteUrl/founders en missing", () => {
    const result = parseRoleListing(roleListingHtml);
    if (!result.ok) throw new Error("unreachable");
    const page = result.value.data;
    expect(page.companies.length).toBe(page.perPage);

    for (const company of page.companies) {
      expect(company.slug).toBeTruthy();
      expect(company.wellfoundUrl).toBe(`https://wellfound.com/company/${company.slug}`);
      expect(company.market).toBeNull();
      expect(company.websiteUrl).toBeNull();
      expect(company.founders).toEqual([]);
      expect(company.extraction.strategy).toBe("hydrated_state");
      expect(company.extraction.missing).toEqual(["market", "websiteUrl", "founders"]);
    }
  });

  it("extrae VaulFi (primera empresa del fixture) con su pitch, tamaño y roles destacados", () => {
    const result = parseRoleListing(roleListingHtml);
    if (!result.ok) throw new Error("unreachable");
    const vaulfi = result.value.data.companies.find((c) => c.slug === "vaulfi-1");

    expect(vaulfi).toBeDefined();
    expect(vaulfi?.name).toBe("VaulFi");
    expect(vaulfi?.pitch).toBe("The Stablecoin Neobank for Emerging Markets");
    expect(vaulfi?.size).toBe("1-10 Employees");
    expect(vaulfi?.jobs.length).toBeGreaterThan(0);

    const job = vaulfi?.jobs[0];
    expect(job?.title).toBeTruthy();
    expect(job?.applyUrl).toMatch(/^https:\/\/wellfound\.com\/jobs\/\d+-/);
  });

  it("parse_failed si el HTML no trae __NEXT_DATA__", () => {
    const result = parseRoleListing("<html><body>nada acá</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("parse_failed");
    }
  });
});
