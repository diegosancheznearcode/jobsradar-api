import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCompanyProfile } from "./CompanyProfileParser.js";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
const blockedHtml = readFileSync(join(fixturesDir, "company-profile-blocked.html"), "utf-8");
const profileAuthHtml = readFileSync(join(fixturesDir, "company-profile-auth.html"), "utf-8");
const peopleAuthHtml = readFileSync(join(fixturesDir, "company-people-auth.html"), "utf-8");

describe("parseCompanyProfile", () => {
  it("devuelve blocked (no parse_failed) contra el challenge de Cloudflare anónimo", () => {
    const result = parseCompanyProfile(blockedHtml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "blocked",
        retryable: true,
        detail: expect.stringContaining("cf_clearance"),
      });
    }
  });

  it("extrae el founder de VaulFi (Karim Khattaby, CTO) desde el perfil autenticado", () => {
    const result = parseCompanyProfile(peopleAuthHtml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.strategy).toBe("hydrated_state");

    const { founders, market, websiteUrl } = result.value.data;
    expect(founders).toHaveLength(1);
    expect(founders[0]).toMatchObject({
      name: "Karim Khattaby",
      role: "CTO",
      profileUrl: "https://wellfound.com/u/karim-khattaby-1",
      linkedinUrl: null,
      source: "company_profile",
    });
    expect(websiteUrl).toBe("https://vaulfi.com");
    expect(market).toContain("Banking");
  });

  it("también extrae founders desde el perfil general (no solo /people)", () => {
    const result = parseCompanyProfile(profileAuthHtml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.data.founders).toHaveLength(1);
  });

  it("parse_failed (no blocked) si el HTML no tiene challenge ni __NEXT_DATA__", () => {
    const result = parseCompanyProfile("<html><body>nada acá</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("parse_failed");
    }
  });
});
