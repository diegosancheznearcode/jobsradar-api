import { describe, expect, it } from "vitest";
import {
  CompanySchema,
  FounderSchema,
  JobPostingSchema,
  SearchCriteriaSchema,
  SearchEventSchema,
} from "./index.js";

describe("SearchCriteriaSchema", () => {
  it("aplica los defaults de remoteOnly y targetCompanies", () => {
    const result = SearchCriteriaSchema.parse({ jobTitle: "Backend Engineer" });
    expect(result.remoteOnly).toBe(true);
    expect(result.targetCompanies).toBe(50);
  });

  it("rechaza jobTitle demasiado corto", () => {
    expect(() => SearchCriteriaSchema.parse({ jobTitle: "a" })).toThrow();
  });

  it("rechaza targetCompanies fuera de [1, 50]", () => {
    expect(() =>
      SearchCriteriaSchema.parse({ jobTitle: "Backend Engineer", targetCompanies: 51 }),
    ).toThrow();
  });
});

describe("FounderSchema", () => {
  it("acepta role/profileUrl/linkedinUrl en null (regla de nulabilidad)", () => {
    const result = FounderSchema.parse({
      name: "Karim Khattaby",
      role: null,
      profileUrl: null,
      linkedinUrl: null,
      source: "company_profile",
    });
    expect(result.role).toBeNull();
  });

  it("rechaza un source fuera del enum", () => {
    expect(() =>
      FounderSchema.parse({
        name: "Karim Khattaby",
        role: null,
        profileUrl: null,
        linkedinUrl: null,
        source: "linkedin_scrape",
      }),
    ).toThrow();
  });
});

describe("JobPostingSchema", () => {
  it("exige applyUrl como URL válida", () => {
    expect(() =>
      JobPostingSchema.parse({
        externalId: "3392132",
        title: "Backend Engineer",
        location: null,
        isRemote: true,
        applyUrl: "no-es-una-url",
        postedAt: null,
      }),
    ).toThrow();
  });

  it("acepta postedAt null", () => {
    const result = JobPostingSchema.parse({
      externalId: "3392132",
      title: "Backend Engineer",
      location: "San Francisco",
      isRemote: true,
      applyUrl: "https://wellfound.com/jobs/3392132-backend-engineer",
      postedAt: null,
    });
    expect(result.postedAt).toBeNull();
  });
});

describe("CompanySchema", () => {
  const validCompany = {
    slug: "vaulfi-1",
    name: "VaulFi",
    pitch: "The Stablecoin Neobank for Emerging Markets",
    size: "1-10 Employees",
    market: null,
    websiteUrl: "https://vaulfi.com",
    wellfoundUrl: "https://wellfound.com/company/vaulfi-1",
    founders: [],
    jobs: [],
    extraction: { strategy: "hydrated_state", confidence: 0.9, missing: ["market"] },
  };

  it("valida una empresa completa", () => {
    expect(() => CompanySchema.parse(validCompany)).not.toThrow();
  });

  it("aplica default [] a founders y jobs cuando se omiten", () => {
    const { founders: _f, jobs: _j, ...withoutArrays } = validCompany;
    const result = CompanySchema.parse(withoutArrays);
    expect(result.founders).toEqual([]);
    expect(result.jobs).toEqual([]);
  });

  it("rechaza una estrategia de extracción fuera de la cascada", () => {
    expect(() =>
      CompanySchema.parse({
        ...validCompany,
        extraction: { ...validCompany.extraction, strategy: "regex" },
      }),
    ).toThrow();
  });
});

describe("SearchEventSchema", () => {
  it("discrimina por type y valida el shape de company.failed", () => {
    const result = SearchEventSchema.parse({
      type: "company.failed",
      slug: "vaulfi-1",
      reason: "parse_failed",
    });
    expect(result.type).toBe("company.failed");
  });

  it("rechaza un evento paused con reason fuera del enum", () => {
    expect(() =>
      SearchEventSchema.parse({ type: "paused", reason: "manual", resumeAt: "2026-08-26T00:00:00Z" }),
    ).toThrow();
  });

  it("rechaza un type desconocido", () => {
    expect(() => SearchEventSchema.parse({ type: "company.started", slug: "x" })).toThrow();
  });
});
