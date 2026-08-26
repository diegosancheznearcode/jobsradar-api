import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresSearchRepository, runMigrations } from "@jobsradar/repository-postgres";
import { buildApp } from "./app.js";

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

function testApp(overrides: Partial<Parameters<typeof buildApp>[0]> = {}) {
  return buildApp({
    repository,
    allowedOrigins: ["http://localhost:5173"],
    enqueueSearchList: vi.fn().mockResolvedValue(undefined),
    subscribeToSearch: () => () => {},
    ...overrides,
  });
}

describe("GET /health", () => {
  it("responde ok", async () => {
    const app = testApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("POST /api/searches", () => {
  it("202 + searchId con criteria válido, y encola la primera página", async () => {
    const enqueueSearchList = vi.fn().mockResolvedValue(undefined);
    const app = testApp({ enqueueSearchList });

    const response = await app.inject({
      method: "POST",
      url: "/api/searches",
      payload: { jobTitle: "Backend Engineer", remoteOnly: true },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.searchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(enqueueSearchList).toHaveBeenCalledWith({
      searchId: body.searchId,
      criteria: { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 },
      page: 1,
    });
  });

  it("400 con criteria inválido (jobTitle muy corto)", async () => {
    const app = testApp();
    const response = await app.inject({ method: "POST", url: "/api/searches", payload: { jobTitle: "a" } });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/searches/:id", () => {
  it("devuelve status/progress/companies de una búsqueda real", async () => {
    const app = testApp();
    const searchId = await repository.create({ jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 10 });

    const response = await app.inject({ method: "GET", url: `/api/searches/${searchId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "queued",
      progress: { found: 0, target: 10 },
      companies: [],
    });
  });

  it("404 si la búsqueda no existe", async () => {
    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/searches/00000000-0000-0000-0000-000000000000",
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/searches/:id/export", () => {
  it("devuelve CSV con las empresas de la búsqueda", async () => {
    const app = testApp();
    const searchId = await repository.create({ jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 10 });
    await repository.attachCompany(
      searchId,
      {
        slug: "vaulfi-1",
        name: "VaulFi",
        pitch: "The Stablecoin Neobank",
        size: "1-10 Employees",
        market: null,
        websiteUrl: null,
        wellfoundUrl: "https://wellfound.com/company/vaulfi-1",
        founders: [],
        jobs: [],
        extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
      },
      1,
    );

    const response = await app.inject({ method: "GET", url: `/api/searches/${searchId}/export` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).toContain("vaulfi-1,VaulFi");
  });
});

describe("GET /api/searches/:id/stream", () => {
  it("emite cada evento como un frame SSE, cierra al recibir 'done' y limpia la suscripción", async () => {
    const unsubscribe = vi.fn();
    const app = testApp({
      subscribeToSearch: (_searchId, onEvent) => {
        setTimeout(() => {
          onEvent({ type: "progress", found: 1, target: 50, page: 1 });
          onEvent({ type: "done", total: 1, partial: 0 });
        }, 0);
        return unsubscribe;
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/searches/any-id/stream" });

    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toContain('data: {"type":"progress","found":1,"target":50,"page":1}');
    expect(response.body).toContain('data: {"type":"done","total":1,"partial":0}');
    // Se llama dos veces: una al terminar el stream (evento done) y otra
    // desde request.raw.on("close", ...) cuando inject() cierra la
    // conexión simulada — unsubscribe debe tolerar llamarse más de una vez.
    expect(unsubscribe).toHaveBeenCalled();
  });
});
