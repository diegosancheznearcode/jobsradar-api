import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, SearchCriteria, SearchEvent } from "@diegosancheznearcode/contracts";
import type { EventPublisherPort, ExtractionError, JobSourcePort, Result } from "@jobsradar/domain";
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

function company(slug: string, overrides: Partial<Company> = {}): Company {
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
    jobs: [],
    extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
    ...overrides,
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

function fakeEvents(): EventPublisherPort & { published: SearchEvent[] } {
  const published: SearchEvent[] = [];
  return {
    published,
    publish: async (_searchId, event) => {
      published.push(event);
    },
  };
}

describe("processSearchList", () => {
  it("persiste cada empresa con rank consecutivo y encola company-detail por cada una", async () => {
    const searchId = await repository.create(criteria);
    const adapter = fakeAdapter({ 1: { companies: [company("a"), company("b")], hasMore: false } });
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);
    const events = fakeEvents();

    await processSearchList(
      { searchId, criteria, page: 1 },
      { adapter, repository, events, enqueueCompanyDetail, enqueueNextPage },
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
      {
        adapter,
        repository,
        events: fakeEvents(),
        enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined),
        enqueueNextPage,
      },
    );

    expect(enqueueNextPage).toHaveBeenCalledWith({ searchId, criteria, page: 2 });
    expect((await repository.getSnapshot(searchId)).status).toBe("running");
  });

  it("NO encola la página siguiente si ya se llegó al target, aunque hasMore sea true", async () => {
    const searchId = await repository.create({ ...criteria, targetCompanies: 2 });
    const adapter = fakeAdapter({ 1: { companies: [company("a"), company("b")], hasMore: true } });
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);
    const events = fakeEvents();

    await processSearchList(
      { searchId, criteria: { ...criteria, targetCompanies: 2 }, page: 1 },
      { adapter, repository, events, enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined), enqueueNextPage },
    );

    expect(enqueueNextPage).not.toHaveBeenCalled();
    expect((await repository.getSnapshot(searchId)).status).toBe("done");
    expect(events.published).toContainEqual({ type: "done", total: 2, partial: 2 });
  });

  it("corta a mitad de página al llegar al target — no procesa la página entera si target < companies de la página", async () => {
    // Bug real reportado por el usuario: con targetCompanies=3, una sola
    // página del listado (hasta 20 empresas) se procesaba entera antes de
    // chequear el target — "3" solo decidía si pedir otra página, nunca
    // limitaba cuántas empresas terminaba teniendo la búsqueda (la UI
    // mostraba "13 / 3 empresas" con 13 filas en la tabla).
    const searchId = await repository.create({ ...criteria, targetCompanies: 3 });
    const adapter = fakeAdapter({
      1: {
        companies: [company("a"), company("b"), company("c"), company("d"), company("e")],
        hasMore: true,
      },
    });
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);

    await processSearchList(
      { searchId, criteria: { ...criteria, targetCompanies: 3 }, page: 1 },
      { adapter, repository, events: fakeEvents(), enqueueCompanyDetail, enqueueNextPage },
    );

    const snapshot = await repository.getSnapshot(searchId);
    expect(snapshot.companies.map((c) => c.slug)).toEqual(["a", "b", "c"]);
    expect(snapshot.status).toBe("done");
    expect(enqueueCompanyDetail).toHaveBeenCalledTimes(3);
    expect(enqueueNextPage).not.toHaveBeenCalled();
  });

  it("con maxCompanySize, descarta empresas que exceden el tope antes de persistir/contar", async () => {
    const searchCriteria: SearchCriteria = { ...criteria, maxCompanySize: 50 };
    const searchId = await repository.create(searchCriteria);
    const adapter = fakeAdapter({
      1: {
        companies: [
          company("chica", { size: "11-50 Employees" }),
          company("grande", { size: "501-1000 Employees" }),
        ],
        hasMore: false,
      },
    });
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);

    await processSearchList(
      { searchId, criteria: searchCriteria, page: 1 },
      {
        adapter,
        repository,
        events: fakeEvents(),
        enqueueCompanyDetail,
        enqueueNextPage: vi.fn().mockResolvedValue(undefined),
      },
    );

    const snapshot = await repository.getSnapshot(searchId);
    expect(snapshot.companies.map((c) => c.slug)).toEqual(["chica"]);
    expect(enqueueCompanyDetail).toHaveBeenCalledTimes(1);
    expect(enqueueCompanyDetail).toHaveBeenCalledWith({ searchId, slug: "chica" });
  });

  it("corta al llegar al tope de páginas aunque hasMore siga true y no se haya llegado al target", async () => {
    const searchId = await repository.create(criteria); // target=3
    const adapter = fakeAdapter({ 2: { companies: [company("b")], hasMore: true } });
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);
    const events = fakeEvents();

    await processSearchList(
      { searchId, criteria, page: 2 },
      {
        adapter,
        repository,
        events,
        enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined),
        enqueueNextPage,
        maxPages: 2,
      },
    );

    expect(enqueueNextPage).not.toHaveBeenCalled();
    expect((await repository.getSnapshot(searchId)).status).toBe("done");
    expect(events.published).toContainEqual({ type: "done", total: 1, partial: 1 });
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
        events: fakeEvents(),
        enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined),
        enqueueNextPage: vi.fn().mockResolvedValue(undefined),
      },
    );

    const snapshot = await repository.getSnapshot(searchId);
    expect(snapshot.companies).toHaveLength(2);
  });

  it("si una empresa ya se había encontrado en una página anterior, no la re-publica ni re-encola company-detail", async () => {
    // Wellfound puede repetir una empresa entre páginas (paginación no
    // perfectamente estable) — bug real: sin este chequeo, la UI duplicaba
    // la fila (React: "two children with the same key") y se desperdiciaba
    // un fetch de company-detail para una empresa ya (siendo) enriquecida.
    const searchId = await repository.create(criteria);
    await repository.attachCompany(searchId, company("a"), 1);

    const adapter = fakeAdapter({ 2: { companies: [company("a"), company("b")], hasMore: false } });
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);
    const events = fakeEvents();

    await processSearchList(
      { searchId, criteria, page: 2 },
      {
        adapter,
        repository,
        events,
        enqueueCompanyDetail,
        enqueueNextPage: vi.fn().mockResolvedValue(undefined),
      },
    );

    const snapshot = await repository.getSnapshot(searchId);
    expect(snapshot.companies.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(enqueueCompanyDetail).toHaveBeenCalledTimes(1);
    expect(enqueueCompanyDetail).toHaveBeenCalledWith({ searchId, slug: "b" });
    expect(events.published.filter((e) => e.type === "company.found")).toHaveLength(1);
  });

  it("publica company.found por cada empresa y progress al final de la página", async () => {
    const searchId = await repository.create(criteria);
    const adapter = fakeAdapter({ 1: { companies: [company("a")], hasMore: false } });
    const events = fakeEvents();

    await processSearchList(
      { searchId, criteria, page: 1 },
      {
        adapter,
        repository,
        events,
        enqueueCompanyDetail: vi.fn().mockResolvedValue(undefined),
        enqueueNextPage: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(events.published).toContainEqual({ type: "company.found", company: company("a"), rank: 1 });
    expect(events.published).toContainEqual({ type: "progress", found: 1, target: 3, page: 1 });
  });

  it("si el adapter falla con blocked, pausa la búsqueda y publica 'paused' (no tira, no encola)", async () => {
    const searchId = await repository.create(criteria);
    const adapter: JobSourcePort = {
      listCompanies: async () => ({ ok: false, error: { kind: "blocked", retryable: true, detail: "captcha" } }),
      getCompany: async () => ({ ok: false, error: { kind: "not_found", retryable: false } }),
    };
    const enqueueCompanyDetail = vi.fn().mockResolvedValue(undefined);
    const enqueueNextPage = vi.fn().mockResolvedValue(undefined);
    const events = fakeEvents();
    const log = vi.fn();

    await expect(
      processSearchList(
        { searchId, criteria, page: 1 },
        { adapter, repository, events, enqueueCompanyDetail, enqueueNextPage, log },
      ),
    ).resolves.toBeUndefined();

    expect(enqueueCompanyDetail).not.toHaveBeenCalled();
    expect(enqueueNextPage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocked"));
    expect((await repository.getSnapshot(searchId)).status).toBe("paused");
    expect(events.published[0]).toMatchObject({ type: "paused", reason: "blocked" });
  });
});
