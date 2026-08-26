import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "./HttpClient.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Sleep/random inyectados en todos los tests — evita esperar 6-10s reales
// por cada request y hace el jitter determinístico.
function testClient(overrides: ConstructorParameters<typeof HttpClient>[0] = {}) {
  return new HttpClient({
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0.5,
    ...overrides,
  });
}

describe("HttpClient.get", () => {
  it("devuelve el body en texto si la respuesta es 200", async () => {
    server.use(http.get("https://wellfound.com/role/r/backend-engineer", () => HttpResponse.text("<html>ok</html>")));

    const client = testClient();
    const result = await client.get("https://wellfound.com/role/r/backend-engineer");

    expect(result).toEqual({ ok: true, value: "<html>ok</html>" });
  });

  it("no manda Cookie si withSession no se pide, aunque haya storageState", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsradar-http-"));
    const storageStatePath = join(dir, "storageState.json");
    writeFileSync(
      storageStatePath,
      JSON.stringify({ cookies: [{ name: "cf_clearance", value: "abc", domain: ".wellfound.com", path: "/" }] }),
    );

    let receivedCookie: string | null = null;
    server.use(
      http.get("https://wellfound.com/jobs/1-x", ({ request }) => {
        receivedCookie = request.headers.get("cookie");
        return HttpResponse.text("ok");
      }),
    );

    const client = testClient({ storageStatePath });
    await client.get("https://wellfound.com/jobs/1-x");

    expect(receivedCookie).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("manda el Cookie del storageState cuando withSession: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsradar-http-"));
    const storageStatePath = join(dir, "storageState.json");
    writeFileSync(
      storageStatePath,
      JSON.stringify({ cookies: [{ name: "cf_clearance", value: "abc", domain: ".wellfound.com", path: "/" }] }),
    );

    let receivedCookie: string | null = null;
    server.use(
      http.get("https://wellfound.com/company/vaulfi-1", ({ request }) => {
        receivedCookie = request.headers.get("cookie");
        return HttpResponse.text("ok");
      }),
    );

    const client = testClient({ storageStatePath });
    await client.get("https://wellfound.com/company/vaulfi-1", { withSession: true });

    expect(receivedCookie).toBe("cf_clearance=abc");
    rmSync(dir, { recursive: true, force: true });
  });

  it('403 con header cf-mitigated -> blocked, sin reintentar', async () => {
    let requestCount = 0;
    server.use(
      http.get("https://wellfound.com/company/blocked-co", () => {
        requestCount++;
        return new HttpResponse("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
      }),
    );

    const client = testClient();
    const result = await client.get("https://wellfound.com/company/blocked-co", { withSession: true });

    expect(result).toEqual({
      ok: false,
      error: { kind: "blocked", retryable: true, detail: "403 Cf-Mitigated: challenge" },
    });
    expect(requestCount).toBe(1);
  });

  it("403 sin cf-mitigated -> not_found, sin reintentar", async () => {
    server.use(http.get("https://wellfound.com/company/no-existe", () => new HttpResponse(null, { status: 403 })));

    const client = testClient();
    const result = await client.get("https://wellfound.com/company/no-existe");

    expect(result).toEqual({ ok: false, error: { kind: "not_found", retryable: false } });
  });

  it("429 reintenta hasta maxRetries y devuelve rate_limited si nunca se recupera", async () => {
    let requestCount = 0;
    server.use(
      http.get("https://wellfound.com/siempre-429", () => {
        requestCount++;
        return new HttpResponse(null, { status: 429, headers: { "retry-after": "1" } });
      }),
    );

    const client = testClient({ maxRetries: 2 });
    const result = await client.get("https://wellfound.com/siempre-429");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rate_limited");
    expect(requestCount).toBe(3); // intento inicial + 2 reintentos
  });

  it("429 una vez y luego 200 -> se recupera con el reintento", async () => {
    let requestCount = 0;
    server.use(
      http.get("https://wellfound.com/flaky", () => {
        requestCount++;
        if (requestCount === 1) return new HttpResponse(null, { status: 429 });
        return HttpResponse.text("recuperado");
      }),
    );

    const client = testClient();
    const result = await client.get("https://wellfound.com/flaky");

    expect(result).toEqual({ ok: true, value: "recuperado" });
    expect(requestCount).toBe(2);
  });

  it("un fallo de red se trata como rate_limited (retryable)", async () => {
    server.use(http.get("https://wellfound.com/red-caida", () => HttpResponse.error()));

    const client = testClient({ maxRetries: 0 });
    const result = await client.get("https://wellfound.com/red-caida");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rate_limited");
  });
});

describe("HttpClient — espaciado entre requests", () => {
  it("no espera antes del primer request, sí antes del segundo", async () => {
    server.use(http.get("https://wellfound.com/*", () => HttpResponse.text("ok")));

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = testClient({ sleep, minDelayMs: 6000, maxDelayMs: 10000, random: () => 0 });

    await client.get("https://wellfound.com/a");
    expect(sleep).not.toHaveBeenCalled();

    await client.get("https://wellfound.com/b");
    expect(sleep).toHaveBeenCalledTimes(1);
    const waited = sleep.mock.calls[0]?.[0] as number;
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(6000);
  });
});
