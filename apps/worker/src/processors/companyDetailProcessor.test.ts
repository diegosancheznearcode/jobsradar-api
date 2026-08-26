import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, SearchCriteria } from "@jobsradar/contracts";
import type { JobSourcePort } from "@jobsradar/domain";
import { PostgresSearchRepository, runMigrations } from "@jobsradar/repository-postgres";
import { processCompanyDetail } from "./companyDetailProcessor.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jobsradar:jobsradar@localhost:5432/jobsradar";
const sql = postgres(DATABASE_URL);
const repository = new PostgresSearchRepository(sql);

beforeAll(async () => {
  await runMigrations(sql);
});
beforeEach(async () => {
  await sql`TRUNCATE search_results, job_postings, founders, companies, searches CASCADE`;
});
afterAll(async () => sql.end());

const criteria: SearchCriteria = { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 };

function baseCompany(): Company {
  return {
    slug: "vaulfi-1",
    name: "VaulFi",
    pitch: null,
    size: null,
    market: null,
    websiteUrl: null,
    wellfoundUrl: "https://wellfound.com/company/vaulfi-1",
    founders: [],
    jobs: [],
    extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
  };
}

function enrichedCompany(): Company {
  return {
    ...baseCompany(),
    market: "Banking",
    websiteUrl: "https://vaulfi.com",
    founders: [{ name: "Karim Khattaby", role: "CTO", profileUrl: null, linkedinUrl: null, source: "company_profile" }],
    extraction: { strategy: "hydrated_state", confidence: 0.9, missing: [] },
  };
}

describe("processCompanyDetail", () => {
  it("pide getCompany y persiste el resultado enriquecido", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: enrichedCompany() }),
    };

    await processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository });

    const found = await repository.findCompanyBySlug("vaulfi-1", 24);
    expect(found?.founders).toHaveLength(1);
    expect(found?.market).toBe("Banking");
  });

  it("si ya está cacheada con founders, no vuelve a pedir getCompany", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, enrichedCompany(), 1);

    const getCompany = vi.fn();
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany,
    };

    await processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository });

    expect(getCompany).not.toHaveBeenCalled();
  });

  it("blocked se loguea y no tira", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: false, error: { kind: "blocked", retryable: true, detail: "captcha" } }),
    };
    const log = vi.fn();

    await expect(processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, log })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocked"));
  });
});
