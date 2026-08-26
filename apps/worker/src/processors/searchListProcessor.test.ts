import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, SearchCriteria } from "@jobsradar/contracts";
import type { ExtractionError, JobSourcePort, Result } from "@jobsradar/domain";
import { PostgresSearchRepository, runMigrations } from "@jobsradar/repository-postgres";
import { processSearchList } from "./searchListProcessor.js";

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

const criteria: SearchCriteria = { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 3 };

function company(slug: string): Company {
  return {
    slug,
    name: slug,
    pitch: null,
    size: null,
    market: null,
    websiteUrl: null,
    wellfoundUrl: `https://wellfound.com/company/${slug}`,
    founders: [],
    jobs: [],
    extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
  };
}

function fakeAdapter(pages: Record<number, { companies: Company[]; hasMore: boolean }>): JobSourcePort {
  return {
    listCompanies: async (_criteria, page): Promise<Result<{ companies: Company[]; hasMore: boolean }, ExtractionError>> => {
      const result = pages[page];
      if (!result) return { ok: false, error: { kind: "not_found", retryable: false } };
      return { ok: true, value: result };
    },
    getCompany: async () => ({ ok: false, error: { kind: "not_found", retryable: false } }),
  };
}

describe("processSearchList", () => {
  it("persiste cada empresa con rank consecutivo y encola company-detail por cada una", async () => {
    const searchId = await repository.create(criteria);
    const adapter = fakeAdapter({ 1: { companies: [company("a"), company("b")], hasMore: false } });
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);

    await processSearchList(
      { searchId, criteria, page: 1 },
      { adapter, repository, enqueueCompanyDetail, enqueueNextPage },
    );

    const snapshot = await repository.getSnapshot(searchId);
    expect(snapshot.companies.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(enqueueCompanyDetail).toHaveBeenCalledTimes(2);
    expect(enqueueCompanyDetail).toHaveBeenCalledWith({ searchId, slug: "a" });
    expect(enqueueCompanyDetail).toHaveBeenCalledWith({ searchId, slug: "b" });
  });

  it("encola la página siguiente si hasMore y todavía no se llegó al target", async () => {
    const searchId = await repository.create(criteria); // target=3
    const adapter = fakeAdapter({ 1: { companies: [company("a")], hasMore: true } });
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);

    await processSearchList(
      { searchId, criteria, page: 1 },
      { adapter, repository, enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined), enqueueNextPage },
    );

    expect(enqueueNextPage).toHaveBeenCalledWith({ searchId, criteria, page: 2 });
  });

  it("NO encola la página siguiente si ya se llegó al target, aunque hasMore sea true", async () => {
    const searchId = await repository.create({ ...criteria, targetCompanies: 2 });
    const adapter = fakeAdapter({ 1: { companies: [company("a"), company("b")], hasMore: true } });
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);

    await processSearchList(
      { searchId, criteria: { ...criteria, targetCompanies: 2 }, page: 1 },
      { adapter, repository, enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined), enqueueNextPage },
    );

    expect(enqueueNextPage).not.toHaveBeenCalled();
  });

  it("el rank de una segunda página sigue desde donde quedó la primera", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, company("a"), 1);

    const adapter = fakeAdapter({ 2: { companies: [company("b")], hasMore: false } });
    await processSearchList(
      { searchId, criteria, page: 2 },
      {
        adapter,
        repository,
        enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined),
        enqueueNextPage: vi.fn().mockResolvedValue(undefined),
      },
    );

    const snapshot = await repository.getSnapshot(searchId);
    expect(snapshot.companies).toHaveLength(2);
  });

  it("si el adapter falla (blocked/parse_failed), no tira y no encola nada", async () => {
    const searchId = await repository.create(criteria);
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: false, error: { kind: "blocked", retryable: true, detail: "captcha" } }),
      getCompany: async () => ({ ok: false, error: { kind: "not_found", retryable: false } }),
    };
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      processSearchList({ searchId, criteria, page: 1 }, { adapter, repository, enqueueCompanyDetail, enqueueNextPage, log }),
    ).resolves.toBeUndefined();

    expect(enqueueCompanyDetail).not.toHaveBeenCalled();
    expect(enqueueNextPage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocked"));
  });
});
