import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, SearchCriteria } from "@jobsradar/contracts";
import { PostgresSearchRepository, runMigrations } from "@jobsradar/repository-postgres";
import { processJobDetail } from "./jobDetailProcessor.js";

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
    slug: "speak",
    name: "Speak",
    pitch: null,
    size: null,
    market: null,
    websiteUrl: null,
    wellfoundUrl: "https://wellfound.com/company/speak",
    founders: [],
    jobs: [],
    extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
  };
}

describe("processJobDetail", () => {
  it("actualiza market/websiteUrl de la empresa a partir del detalle de vacante", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const fetchJobDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        strategy: "json_ld",
        data: {
          job: {
            externalId: "3392132-backend-engineer",
            title: "Backend Engineer",
            location: "San Francisco, California",
            isRemote: true,
            applyUrl: "https://wellfound.com/jobs/3392132-backend-engineer",
            postedAt: null,
          },
          company: { name: "Speak", market: "Education", websiteUrl: "http://speak.com" },
        },
      },
    });

    await processJobDetail(
      { searchId, slug: "speak", jobUrl: "https://wellfound.com/jobs/3392132-backend-engineer" },
      { fetchJobDetail, repository },
    );

    const found = await repository.findCompanyBySlug("speak", 24);
    expect(found?.market).toBe("Education");
    expect(found?.websiteUrl).toBe("http://speak.com");
  });

  it("un error del fetch se loguea y no tira", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const fetchJobDetail = vi.fn().mockResolvedValue({
      ok: false,
      error: { kind: "parse_failed", retryable: false, strategy: "json_ld", html: "<html></html>" },
    });
    const log = vi.fn();

    await expect(
      processJobDetail(
        { searchId, slug: "speak", jobUrl: "https://wellfound.com/jobs/x" },
        { fetchJobDetail, repository, log },
      ),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("parse_failed"));
  });
});
