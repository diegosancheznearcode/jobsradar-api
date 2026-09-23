import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Company, SearchCriteria } from "@nearcodecr/jobsradar-contracts";
import { runMigrations } from "./migrate.js";
import { PostgresSearchRepository } from "./PostgresSearchRepository.js";

// Integración contra Postgres real (sección 11 no cubre el repositorio
// explícitamente — para SQL sin ORM, mockear no prueba nada útil; la
// alternativa real es una base de test de verdad, como acá). Requiere
// `docker compose up -d postgres` (ver docker-compose.yml, sección 9).

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jobsradar:jobsradar@localhost:5432/jobsradar";
const sql = postgres(DATABASE_URL);
const repo = new PostgresSearchRepository(sql);

beforeAll(async () => {
  await runMigrations(sql);
});

beforeEach(async () => {
  await sql`TRUNCATE search_results, job_postings, founders, companies, searches CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const baseCriteria: SearchCriteria = {
  jobTitle: "Backend Engineer",
  remoteOnly: true,
  targetCompanies: 50,
};

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    slug: "vaulfi-1",
    name: "VaulFi",
    pitch: "The Stablecoin Neobank for Emerging Markets",
    size: "1-10 Employees",
    market: null,
    websiteUrl: null,
    linkedinUrl: null,
    wellfoundUrl: "https://wellfound.com/company/vaulfi-1",
    founders: [],
    jobs: [],
    extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
    ...overrides,
  };
}

describe("PostgresSearchRepository.create", () => {
  it("crea una búsqueda y devuelve un UUID", async () => {
    const searchId = await repo.create(baseCriteria);
    expect(searchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("arranca en status 'queued'", async () => {
    const searchId = await repo.create(baseCriteria);
    const snapshot = await repo.getSnapshot(searchId);
    expect(snapshot.status).toBe("queued");
  });
});

describe("PostgresSearchRepository.updateStatus", () => {
  it("transiciona el status y getSnapshot lo refleja", async () => {
    const searchId = await repo.create(baseCriteria);

    await repo.updateStatus(searchId, "running");
    expect((await repo.getSnapshot(searchId)).status).toBe("running");

    await repo.updateStatus(searchId, "done");
    expect((await repo.getSnapshot(searchId)).status).toBe("done");
  });
});

describe("PostgresSearchRepository.getStatus", () => {
  it("devuelve el status actual sin traer companies (más liviano que getSnapshot)", async () => {
    const searchId = await repo.create(baseCriteria);
    expect(await repo.getStatus(searchId)).toBe("queued");

    await repo.updateStatus(searchId, "done");
    expect(await repo.getStatus(searchId)).toBe("done");
  });

  it("tira si la búsqueda no existe", async () => {
    await expect(repo.getStatus("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});

// Pedido explícito del usuario ("el spinner no se puede dejar hasta que
// cargue todo") — ver el comentario en SearchRepositoryPort.
describe("PostgresSearchRepository — contadores de company-detail (enrichment.done)", () => {
  it("arrancan en 0/0", async () => {
    const searchId = await repo.create(baseCriteria);
    expect(await repo.getCompanyDetailCounts(searchId)).toEqual({ enqueued: 0, completed: 0 });
  });

  it("recordCompanyDetailEnqueued suma de a uno", async () => {
    const searchId = await repo.create(baseCriteria);
    await repo.recordCompanyDetailEnqueued(searchId);
    await repo.recordCompanyDetailEnqueued(searchId);
    await repo.recordCompanyDetailEnqueued(searchId);
    expect(await repo.getCompanyDetailCounts(searchId)).toEqual({ enqueued: 3, completed: 0 });
  });

  it("recordCompanyDetailCompleted suma de a uno y devuelve los dos contadores actualizados", async () => {
    const searchId = await repo.create(baseCriteria);
    await repo.recordCompanyDetailEnqueued(searchId);
    await repo.recordCompanyDetailEnqueued(searchId);

    const afterFirst = await repo.recordCompanyDetailCompleted(searchId);
    expect(afterFirst).toEqual({ enqueued: 2, completed: 1 });

    const afterSecond = await repo.recordCompanyDetailCompleted(searchId);
    expect(afterSecond).toEqual({ enqueued: 2, completed: 2 });
  });

  it("los contadores son independientes por búsqueda", async () => {
    const searchA = await repo.create(baseCriteria);
    const searchB = await repo.create(baseCriteria);

    await repo.recordCompanyDetailEnqueued(searchA);
    await repo.recordCompanyDetailEnqueued(searchA);
    await repo.recordCompanyDetailEnqueued(searchB);

    expect(await repo.getCompanyDetailCounts(searchA)).toEqual({ enqueued: 2, completed: 0 });
    expect(await repo.getCompanyDetailCounts(searchB)).toEqual({ enqueued: 1, completed: 0 });
  });
});

describe("PostgresSearchRepository.attachCompany + findCompanyBySlug", () => {
  it("round-trip: attach y después find devuelve la misma empresa", async () => {
    const searchId = await repo.create(baseCriteria);
    const company = makeCompany({
      founders: [
        { name: "Karim Khattaby", role: "CTO", profileUrl: "https://wellfound.com/u/karim-khattaby-1", linkedinUrl: null, source: "company_profile" },
      ],
      jobs: [
        { externalId: "1", title: "Backend Engineer", location: "Delaware", isRemote: true, applyUrl: "https://wellfound.com/jobs/1-backend-engineer", postedAt: null },
      ],
    });

    await repo.attachCompany(searchId, company, 1);
    const found = await repo.findCompanyBySlug("vaulfi-1", 24);

    expect(found).toMatchObject({
      slug: "vaulfi-1",
      name: "VaulFi",
      founders: [{ name: "Karim Khattaby", role: "CTO" }],
      jobs: [{ externalId: "1", title: "Backend Engineer" }],
    });
  });

  it("devuelve null si la empresa no existe", async () => {
    expect(await repo.findCompanyBySlug("no-existe", 24)).toBeNull();
  });

  it("respeta maxAgeHours: con 0 horas, algo recién scrapeado ya no cuenta como fresco", async () => {
    const searchId = await repo.create(baseCriteria);
    await repo.attachCompany(searchId, makeCompany(), 1);

    expect(await repo.findCompanyBySlug("vaulfi-1", 0)).toBeNull();
    expect(await repo.findCompanyBySlug("vaulfi-1", 24)).not.toBeNull();
  });

  it("merge no destructivo: una segunda llamada con datos parciales no borra lo que ya se sabía", async () => {
    const searchId = await repo.create(baseCriteria);

    await repo.attachCompany(
      searchId,
      makeCompany({
        market: "Banking",
        websiteUrl: "https://vaulfi.com",
        linkedinUrl: "https://www.linkedin.com/company/vaulfi",
        founders: [{ name: "Karim Khattaby", role: "CTO", profileUrl: null, linkedinUrl: null, source: "company_profile" }],
      }),
      1,
    );

    // Segunda llamada: como si viniera del listado, sin market/website/linkedin/founders.
    await repo.attachCompany(
      searchId,
      makeCompany({ market: null, websiteUrl: null, linkedinUrl: null, founders: [] }),
      1,
    );

    const found = await repo.findCompanyBySlug("vaulfi-1", 24);
    expect(found?.market).toBe("Banking");
    expect(found?.websiteUrl).toBe("https://vaulfi.com");
    expect(found?.linkedinUrl).toBe("https://www.linkedin.com/company/vaulfi");
    expect(found?.founders).toHaveLength(1);
  });

  it("merge no destructivo: extraction.missing/confidence no retroceden si una llamada posterior tiene menos confianza", async () => {
    // Bug real reportado por el usuario: founders/market/websiteUrl estaban
    // bien guardados (protegidos por COALESCE), pero extraction_missing se
    // sobreescribía siempre con el valor de la última llamada — si esa
    // última era un re-hallazgo desde el listado de OTRA búsqueda (menos
    // confianza, sin founders), la tabla mostraba "—" para datos que en
    // realidad sí estaban ahí.
    const searchId = await repo.create(baseCriteria);

    await repo.attachCompany(
      searchId,
      makeCompany({
        market: "Software",
        websiteUrl: "https://venura.ai",
        founders: [{ name: "Venura AI", role: null, profileUrl: null, linkedinUrl: null, source: "company_profile" }],
        extraction: { strategy: "hydrated_state", confidence: 0.9, missing: [] },
      }),
      1,
    );

    // Segunda llamada: como si search-list la re-encontrara en otra
    // búsqueda, solo con lo que trae el listado (menos confianza).
    await repo.attachCompany(
      searchId,
      makeCompany({
        market: null,
        websiteUrl: null,
        founders: [],
        extraction: { strategy: "hydrated_state", confidence: 0.6, missing: ["market", "websiteUrl", "founders"] },
      }),
      1,
    );

    const found = await repo.findCompanyBySlug("vaulfi-1", 24);
    expect(found?.market).toBe("Software");
    expect(found?.websiteUrl).toBe("https://venura.ai");
    expect(found?.founders).toHaveLength(1);
    expect(found?.extraction.confidence).toBe(0.9);
    expect(found?.extraction.missing).toEqual([]);
  });

  it("idempotencia (searchId, slug): reintentar attachCompany no duplica la fila en search_results", async () => {
    const searchId = await repo.create(baseCriteria);
    const company = makeCompany();

    await repo.attachCompany(searchId, company, 1);
    await repo.attachCompany(searchId, company, 1);
    await repo.attachCompany(searchId, company, 1);

    const snapshot = await repo.getSnapshot(searchId);
    expect(snapshot.companies).toHaveLength(1);
  });

  it("una empresa se guarda una sola vez y se reutiliza entre dos búsquedas distintas", async () => {
    const searchA = await repo.create(baseCriteria);
    const searchB = await repo.create({ ...baseCriteria, jobTitle: "Software Engineer" });

    await repo.attachCompany(searchA, makeCompany(), 1);
    await repo.attachCompany(searchB, makeCompany(), 3);

    const rows = await sql<{ count: string }[]>`SELECT count(*)::int AS count FROM companies`;
    expect(Number(rows[0]?.count)).toBe(1);

    const snapshotB = await repo.getSnapshot(searchB);
    expect(snapshotB.companies[0]?.slug).toBe("vaulfi-1");
  });
});

describe("PostgresSearchRepository.getSnapshot", () => {
  it("arma status/progress/companies contra lo persistido", async () => {
    const searchId = await repo.create({ ...baseCriteria, targetCompanies: 5 });
    await repo.attachCompany(searchId, makeCompany({ slug: "vaulfi-1", name: "VaulFi" }), 1);
    await repo.attachCompany(searchId, makeCompany({ slug: "otra-co", name: "Otra Co" }), 2);

    const snapshot = await repo.getSnapshot(searchId);

    expect(snapshot.status).toBe("queued");
    expect(snapshot.progress.target).toBe(5);
    expect(snapshot.progress.found).toBe(2);
    expect(snapshot.companies.map((c) => c.slug)).toEqual(["vaulfi-1", "otra-co"]);
  });

  it("tira si la búsqueda no existe", async () => {
    await expect(repo.getSnapshot("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});
