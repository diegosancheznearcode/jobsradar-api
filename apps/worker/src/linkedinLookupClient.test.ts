import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedinLookupClient } from "./linkedinLookupClient.js";

// Pedido explícito del usuario: cuando Wellfound no trae linkedinUrl de una
// empresa, consultar https://talentradar-api-tnxrhfijdq-pv.a.run.app/api/
// empresa-linkedin como fallback. Ese servicio pide un token de
// POST /api/auth/token (usuario/password) que vence a la hora — este
// cliente lo pide una vez y lo reusa hasta que esté por vencer.

function fakeFetch(responses: { auth?: unknown; empresaLinkedin?: unknown; empresaLinkedinStatus?: number }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => responses.auth ?? { token: "fake-token", expires_in: "1h" },
      } as Response;
    }
    if (url.endsWith("/api/empresa-linkedin")) {
      return {
        ok: (responses.empresaLinkedinStatus ?? 200) < 400,
        status: responses.empresaLinkedinStatus ?? 200,
        json: async () => responses.empresaLinkedin ?? { linkedin_url: "https://www.linkedin.com/company/molten-inc" },
      } as Response;
    }
    throw new Error(`URL inesperada en el test: ${url}`);
  });
  return { fn, calls };
}

describe("LinkedinLookupClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("manda url_empresa en el body y devuelve el linkedin_url tal cual lo responde el servicio", async () => {
    const { fn, calls } = fakeFetch({});
    const client = new LinkedinLookupClient({ usuario: "adminexternoapi", password: "secreto", fetchImpl: fn });

    const result = await client.findLinkedinUrl("https://moltencloud.com/");

    expect(result).toBe("https://www.linkedin.com/company/molten-inc");
    const empresaCall = calls.find((c) => c.url.endsWith("/api/empresa-linkedin"))!;
    expect(JSON.parse(empresaCall.init.body as string)).toEqual({ url_empresa: "https://moltencloud.com/" });
    expect((empresaCall.init.headers as Record<string, string>).Authorization).toBe("Bearer fake-token");
  });

  it("pide el token una sola vez y lo reusa mientras no venza", async () => {
    const { fn, calls } = fakeFetch({});
    const client = new LinkedinLookupClient({ usuario: "u", password: "p", fetchImpl: fn });

    await client.findLinkedinUrl("https://a.com/");
    await client.findLinkedinUrl("https://b.com/");

    expect(calls.filter((c) => c.url.endsWith("/api/auth/token"))).toHaveLength(1);
  });

  it("renueva el token si ya venció (expires_in: 1h)", async () => {
    const { fn, calls } = fakeFetch({});
    const client = new LinkedinLookupClient({ usuario: "u", password: "p", fetchImpl: fn });

    await client.findLinkedinUrl("https://a.com/");
    vi.advanceTimersByTime(61 * 60 * 1000); // pasó la hora de vencimiento
    await client.findLinkedinUrl("https://b.com/");

    expect(calls.filter((c) => c.url.endsWith("/api/auth/token"))).toHaveLength(2);
  });

  it("devuelve null (sin tirar) si empresa-linkedin responde con error HTTP — degrada sin fallar", async () => {
    const { fn } = fakeFetch({ empresaLinkedinStatus: 500 });
    const client = new LinkedinLookupClient({ usuario: "u", password: "p", fetchImpl: fn });

    const result = await client.findLinkedinUrl("https://moltencloud.com/");

    expect(result).toBeNull();
  });

  it("devuelve null si linkedin_url no es una URL válida", async () => {
    const { fn } = fakeFetch({ empresaLinkedin: { linkedin_url: "no-es-una-url" } });
    const client = new LinkedinLookupClient({ usuario: "u", password: "p", fetchImpl: fn });

    const result = await client.findLinkedinUrl("https://moltencloud.com/");

    expect(result).toBeNull();
  });

  it("devuelve null si el servicio no encontró nada (sin campo linkedin_url)", async () => {
    const { fn } = fakeFetch({ empresaLinkedin: { url_empresa: "https://moltencloud.com/", query: "..." } });
    const client = new LinkedinLookupClient({ usuario: "u", password: "p", fetchImpl: fn });

    const result = await client.findLinkedinUrl("https://moltencloud.com/");

    expect(result).toBeNull();
  });

  it("devuelve null (sin tirar) si hay un error de red — degrada sin fallar", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const client = new LinkedinLookupClient({ usuario: "u", password: "p", fetchImpl: fn });

    const result = await client.findLinkedinUrl("https://moltencloud.com/");

    expect(result).toBeNull();
  });

  it("manda usuario/password al pedir el token", async () => {
    const { fn, calls } = fakeFetch({});
    const client = new LinkedinLookupClient({ usuario: "adminexternoapi", password: "secreto", fetchImpl: fn });

    await client.findLinkedinUrl("https://moltencloud.com/");

    const authCall = calls.find((c) => c.url.endsWith("/api/auth/token"))!;
    expect(JSON.parse(authCall.init.body as string)).toEqual({ usuario: "adminexternoapi", password: "secreto" });
  });
});
