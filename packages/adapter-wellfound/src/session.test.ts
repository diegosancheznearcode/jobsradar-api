import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCookieHeader, loadStorageState } from "./session.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobsradar-session-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadStorageState", () => {
  it("devuelve null si el archivo no existe", () => {
    expect(loadStorageState(join(dir, "no-existe.json"))).toBeNull();
  });

  it("devuelve null si el JSON está corrupto", () => {
    const path = join(dir, "storageState.json");
    writeFileSync(path, "{ esto no es json");
    expect(loadStorageState(path)).toBeNull();
  });

  it("carga cookies de un storageState válido", () => {
    const path = join(dir, "storageState.json");
    writeFileSync(
      path,
      JSON.stringify({
        cookies: [
          { name: "cf_clearance", value: "abc123", domain: ".wellfound.com", path: "/" },
          { name: "_wellfound", value: "xyz", domain: ".wellfound.com", path: "/" },
        ],
      }),
    );

    const state = loadStorageState(path);
    expect(state?.cookies).toHaveLength(2);
  });
});

describe("buildCookieHeader", () => {
  it("junta name=value separados por '; ', filtrando por dominio", () => {
    const header = buildCookieHeader([
      { name: "cf_clearance", value: "abc123", domain: ".wellfound.com", path: "/" },
      { name: "_wellfound", value: "xyz", domain: ".wellfound.com", path: "/" },
      { name: "otro_sitio", value: "no-debería-salir", domain: ".otrosite.com", path: "/" },
    ]);

    expect(header).toBe("cf_clearance=abc123; _wellfound=xyz");
  });

  it("devuelve string vacío si no hay cookies del dominio", () => {
    expect(buildCookieHeader([{ name: "x", value: "y", domain: ".otrosite.com", path: "/" }])).toBe("");
  });
});
