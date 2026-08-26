import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "./CircuitBreaker.js";
import { HttpClient } from "./HttpClient.js";
import { WellfoundAdapter } from "./WellfoundAdapter.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const roleListingHtml = readFileSync(join(fixturesDir, "role-listing.html"), "utf-8");
const peopleAuthHtml = readFileSync(join(fixturesDir, "company-people-auth.html"), "utf-8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobsradar-adapter-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function testHttpClient(storageStatePath?: string) {
  return new HttpClient({
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0,
    ...(storageStatePath ? { storageStatePath } : {}),
  });
}

describe("WellfoundAdapter.listCompanies", () => {
  it("devuelve Company[] completos (no solo slugs) y hasMore, contra el fixture real de listado (sin sesión)", async () => {
    server.use(http.get("https://wellfound.com/role/r/backend-engineer", () => HttpResponse.text(roleListingHtml)));

    const adapter = new WellfoundAdapter(testHttpClient(), new CircuitBreaker());
    const result = await adapter.listCompanies(
      { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 },
      1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const slugs = result.value.companies.map((c) => c.slug);
    expect(slugs).toContain("vaulfi-1");
    expect(result.value.companies).toHaveLength(20);
    const vaulfi = result.value.companies.find((c) => c.slug === "vaulfi-1");
    expect(vaulfi?.name).toBe("VaulFi");
    expect(vaulfi?.pitch).toBe("The Stablecoin Neobank for Emerging Markets");
    expect(result.value.hasMore).toBe(true);
  });
});

describe("WellfoundAdapter.getCompany", () => {
  it("con sesión válida arma un Company completo con founders", async () => {
    const storageStatePath = join(dir, "storageState.json");
    writeFileSync(
      storageStatePath,
      JSON.stringify({ cookies: [{ name: "cf_clearance", value: "vigente", domain: ".wellfound.com", path: "/" }] }),
    );

    server.use(
      http.get("https://wellfound.com/company/vaulfi-1", ({ request }) => {
        if (!request.headers.get("cookie")) {
          return new HttpResponse("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
        }
        return HttpResponse.text(peopleAuthHtml);
      }),
    );

    const adapter = new WellfoundAdapter(testHttpClient(storageStatePath), new CircuitBreaker());
    const result = await adapter.getCompany("vaulfi-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.name).toBe("VaulFi");
    expect(result.value.founders).toHaveLength(1);
    expect(result.value.founders[0]?.name).toBe("Karim Khattaby");
    expect(result.value.extraction.strategy).toBe("hydrated_state");
  });

  it("sin sesión recibe blocked y abre el circuit breaker", async () => {
    let requestCount = 0;
    server.use(
      http.get("https://wellfound.com/company/vaulfi-1", () => {
        requestCount++;
        return new HttpResponse("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
      }),
    );

    const breaker = new CircuitBreaker();
    const adapter = new WellfoundAdapter(testHttpClient(), breaker);

    const first = await adapter.getCompany("vaulfi-1");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.kind).toBe("blocked");
    expect(breaker.isOpen()).toBe(true);
    expect(requestCount).toBe(1);

    // Con el breaker abierto, la segunda llamada ni siquiera pega a la red.
    const second = await adapter.getCompany("vaulfi-1");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("blocked");
    expect(requestCount).toBe(1);
  });

  it("listCompanies también respeta el breaker ya abierto por getCompany", async () => {
    server.use(
      http.get("https://wellfound.com/company/vaulfi-1", () =>
        HttpResponse.text("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      ),
    );

    let listingRequestCount = 0;
    server.use(
      http.get("https://wellfound.com/role/r/backend-engineer", () => {
        listingRequestCount++;
        return HttpResponse.text(roleListingHtml);
      }),
    );

    const breaker = new CircuitBreaker();
    const adapter = new WellfoundAdapter(testHttpClient(), breaker);

    await adapter.getCompany("vaulfi-1");
    expect(breaker.isOpen()).toBe(true);

    const listResult = await adapter.listCompanies(
      { jobTitle: "Backend Engineer", remoteOnly: true, targetCompanies: 50 },
      1,
    );
    expect(listResult.ok).toBe(false);
    expect(listingRequestCount).toBe(0);
  });
});
