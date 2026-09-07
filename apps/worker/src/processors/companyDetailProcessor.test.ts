import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, SearchCriteria, SearchEvent } from "@diegosancheznearcode/contracts";
import type { EventPublisherPort, JobSourcePort } from "@jobsradar/domain";
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
    linkedinUrl: null,
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
    linkedinUrl: "https://www.linkedin.com/company/vaulfi",
    founders: [{ name: "Karim Khattaby", role: "CTO", profileUrl: null, linkedinUrl: null, source: "company_profile" }],
    extraction: { strategy: "hydrated_state", confidence: 0.9, missing: [] },
  };
}

function fakeEvents(): EventPublisherPort & { published: SearchEvent[] } {
  const published: SearchEvent[] = [];
  return {
    published,
    publish: async (_searchId, event) => {
      published.push(event);
    },
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
    const events = fakeEvents();

    await processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, events });

    const found = await repository.findCompanyBySlug("vaulfi-1", 24);
    expect(found?.founders).toHaveLength(1);
    expect(found?.market).toBe("Banking");
  });

  it("publica company.updated con el estado ya mergeado — sin esto la UI se queda con los datos parciales para siempre", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: enrichedCompany() }),
    };
    const events = fakeEvents();

    await processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, events });

    expect(events.published).toHaveLength(1);
    const [event] = events.published;
    expect(event).toMatchObject({
      type: "company.updated",
      company: {
        slug: "vaulfi-1",
        market: "Banking",
        websiteUrl: "https://vaulfi.com",
        linkedinUrl: "https://www.linkedin.com/company/vaulfi",
      },
    });
    // company.updated no lleva rank, a diferencia de company.found.
    expect(event).not.toHaveProperty("rank");
  });

  it("si ya está cacheada con founders, no vuelve a pedir getCompany", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, enrichedCompany(), 1);

    const getCompany = vi.fn();
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany,
    };

    await processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, events: fakeEvents() });

    expect(getCompany).not.toHaveBeenCalled();
  });

  it("blocked se loguea, pausa la búsqueda y publica 'paused'", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: false, error: { kind: "blocked", retryable: true, detail: "captcha" } }),
    };
    const log = vi.fn();
    const events = fakeEvents();

    await expect(
      processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, events, log }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocked"));
    expect((await repository.getSnapshot(searchId)).status).toBe("paused");
    expect(events.published[0]).toMatchObject({ type: "paused", reason: "blocked" });
  });

  it("si Wellfound no trae linkedinUrl pero hay websiteUrl, consulta el fallback y lo persiste — pedido explícito del usuario", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const sinLinkedin: Company = {
      ...enrichedCompany(),
      linkedinUrl: null,
      extraction: { ...enrichedCompany().extraction, missing: ["linkedinUrl"] },
    };
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: sinLinkedin }),
    };
    const findLinkedinUrl = vi.fn().mockResolvedValue("https://www.linkedin.com/company/molten-inc");

    await processCompanyDetail(
      { searchId, slug: "vaulfi-1" },
      { adapter, repository, events: fakeEvents(), linkedinLookup: { findLinkedinUrl } },
    );

    expect(findLinkedinUrl).toHaveBeenCalledWith("https://vaulfi.com");
    const found = await repository.findCompanyBySlug("vaulfi-1", 24);
    expect(found?.linkedinUrl).toBe("https://www.linkedin.com/company/molten-inc");
    expect(found?.extraction.missing).not.toContain("linkedinUrl");
  });

  it("no consulta el fallback si Wellfound ya trajo linkedinUrl", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: enrichedCompany() }),
    };
    const findLinkedinUrl = vi.fn();

    await processCompanyDetail(
      { searchId, slug: "vaulfi-1" },
      { adapter, repository, events: fakeEvents(), linkedinLookup: { findLinkedinUrl } },
    );

    expect(findLinkedinUrl).not.toHaveBeenCalled();
  });

  it("no consulta el fallback si tampoco hay websiteUrl (no hay qué mandarle al servicio)", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const sinNada: Company = { ...baseCompany(), founders: [{ name: "X", role: null, profileUrl: null, linkedinUrl: null, source: "company_profile" }] };
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: sinNada }),
    };
    const findLinkedinUrl = vi.fn();

    await processCompanyDetail(
      { searchId, slug: "vaulfi-1" },
      { adapter, repository, events: fakeEvents(), linkedinLookup: { findLinkedinUrl } },
    );

    expect(findLinkedinUrl).not.toHaveBeenCalled();
  });

  it("si el fallback no encuentra nada (null), sigue guardando la empresa sin tirar", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const sinLinkedin: Company = { ...enrichedCompany(), linkedinUrl: null };
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: sinLinkedin }),
    };
    const findLinkedinUrl = vi.fn().mockResolvedValue(null);

    await expect(
      processCompanyDetail(
        { searchId, slug: "vaulfi-1" },
        { adapter, repository, events: fakeEvents(), linkedinLookup: { findLinkedinUrl } },
      ),
    ).resolves.toBeUndefined();

    const found = await repository.findCompanyBySlug("vaulfi-1", 24);
    expect(found?.linkedinUrl).toBeNull();
  });

  it("sin linkedinLookup en deps (no configurado), simplemente no intenta el fallback", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const sinLinkedin: Company = { ...enrichedCompany(), linkedinUrl: null };
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: true, value: sinLinkedin }),
    };

    await expect(
      processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, events: fakeEvents() }),
    ).resolves.toBeUndefined();
  });

  it("not_found publica company.failed", async () => {
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, baseCompany(), 1);

    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: true, value: { companies: [], hasMore: false } }),
      getCompany: async () => ({ ok: false, error: { kind: "not_found", retryable: false } }),
    };
    const events = fakeEvents();

    await processCompanyDetail({ searchId, slug: "vaulfi-1" }, { adapter, repository, events });

    expect(events.published).toEqual([{ type: "company.failed", slug: "vaulfi-1", reason: "not_found" }]);
  });
});
