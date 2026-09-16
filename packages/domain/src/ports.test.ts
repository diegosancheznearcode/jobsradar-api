import { describe, expect, it } from "vitest";
import type { Company, SearchCriteria } from "@diegosancheznearcode/contracts";
import { ok } from "./result.js";
import type { CompanyDetailCounts, SearchRepositoryPort, SearchSnapshot } from "./ports.js";

// No hay lógica real que probar en interfaces — esto documenta el contrato
// con una implementación en memoria mínima y confirma que compila y se
// comporta como se espera (findCompanyBySlug es el caché de la sección 5).
class InMemorySearchRepository implements SearchRepositoryPort {
  private companies = new Map<string, Company>();
  private searches = new Map<string, SearchSnapshot>();
  private counts = new Map<string, CompanyDetailCounts>();

  async create(_criteria: SearchCriteria): Promise<string> {
    const id = `search-${this.searches.size + 1}`;
    this.searches.set(id, { status: "queued", progress: { found: 0, target: 0, page: 0 }, companies: [] });
    this.counts.set(id, { enqueued: 0, completed: 0 });
    return id;
  }

  async attachCompany(searchId: string, company: Company, _rank: number): Promise<void> {
    this.companies.set(company.slug, company);
    const snapshot = this.searches.get(searchId);
    if (snapshot) snapshot.companies.push(company);
  }

  async findCompanyBySlug(slug: string, _maxAgeHours: number): Promise<Company | null> {
    return this.companies.get(slug) ?? null;
  }

  async getSnapshot(searchId: string): Promise<SearchSnapshot> {
    const snapshot = this.searches.get(searchId);
    if (!snapshot) throw new Error("not found");
    return snapshot;
  }

  async updateStatus(searchId: string, status: SearchSnapshot["status"]): Promise<void> {
    const snapshot = this.searches.get(searchId);
    if (snapshot) snapshot.status = status;
  }

  async getStatus(searchId: string): Promise<SearchSnapshot["status"]> {
    return (await this.getSnapshot(searchId)).status;
  }

  async recordCompanyDetailEnqueued(searchId: string): Promise<void> {
    const counts = this.counts.get(searchId);
    if (counts) counts.enqueued += 1;
  }

  async recordCompanyDetailCompleted(searchId: string): Promise<CompanyDetailCounts> {
    const counts = this.counts.get(searchId);
    if (!counts) throw new Error("not found");
    counts.completed += 1;
    return { ...counts };
  }

  async getCompanyDetailCounts(searchId: string): Promise<CompanyDetailCounts> {
    const counts = this.counts.get(searchId);
    if (!counts) throw new Error("not found");
    return { ...counts };
  }
}

describe("SearchRepositoryPort (implementación en memoria)", () => {
  it("findCompanyBySlug actúa como caché: null si nunca se attachó", async () => {
    const repo = new InMemorySearchRepository();
    await expect(repo.findCompanyBySlug("vaulfi-1", 24)).resolves.toBeNull();
  });

  it("attachCompany hace que findCompanyBySlug la encuentre después", async () => {
    const repo = new InMemorySearchRepository();
    const searchId = await repo.create({ jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 });
    const company: Company = {
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
      extraction: { strategy: "hydrated_state", confidence: 1, missing: [] },
    };

    const found = ok(company);
    if (!found.ok) throw new Error("unreachable");
    await repo.attachCompany(searchId, found.value, 1);

    await expect(repo.findCompanyBySlug("vaulfi-1", 24)).resolves.toEqual(company);
    await expect(repo.getSnapshot(searchId)).resolves.toMatchObject({ companies: [company] });
  });

  it("updateStatus transiciona el status de la búsqueda", async () => {
    const repo = new InMemorySearchRepository();
    const searchId = await repo.create({ jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 });

    await repo.updateStatus(searchId, "running");
    await expect(repo.getSnapshot(searchId)).resolves.toMatchObject({ status: "running" });
  });

  it("los contadores de company-detail arrancan en 0/0 y suben de a uno (pedido explícito del usuario, enrichment.done)", async () => {
    const repo = new InMemorySearchRepository();
    const searchId = await repo.create({ jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 });

    await expect(repo.getCompanyDetailCounts(searchId)).resolves.toEqual({ enqueued: 0, completed: 0 });

    await repo.recordCompanyDetailEnqueued(searchId);
    await repo.recordCompanyDetailEnqueued(searchId);
    await expect(repo.recordCompanyDetailCompleted(searchId)).resolves.toEqual({ enqueued: 2, completed: 1 });
    await expect(repo.getCompanyDetailCounts(searchId)).resolves.toEqual({ enqueued: 2, completed: 1 });
  });
});
