import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserClient } from "./BrowserClient.js";
import type { BrowserLike, PageLike } from "./BrowserClient.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobsradar-browserclient-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeBrowser(overrides: Partial<PageLike> = {}) {
  const page: PageLike = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue({ cookies: [{ name: "cf_clearance", value: "nuevo" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const browser: BrowserLike = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { browser, context, page };
}

describe("BrowserClient.ensureSession", () => {
  it("no lanza el navegador si ya existe un storageState en disco", async () => {
    const storageStatePath = join(dir, "storageState.json");
    writeFileSync(storageStatePath, JSON.stringify({ cookies: [] }));

    const launch = vi.fn();
    const client = new BrowserClient({ storageStatePath, launch });

    const result = await client.ensureSession();

    expect(result).toEqual({ ok: true, value: { storageStatePath } });
    expect(launch).not.toHaveBeenCalled();
  });

  it("hace login interactivo si no hay storageState todavía", async () => {
    const storageStatePath = join(dir, "storageState.json");
    const { browser, page } = fakeBrowser();
    const launch = vi.fn().mockResolvedValue(browser);

    const client = new BrowserClient({ storageStatePath, launch });
    const result = await client.ensureSession();

    expect(result.ok).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith("https://wellfound.com/login");
    expect(existsSync(storageStatePath)).toBe(true);
    expect(JSON.parse(readFileSync(storageStatePath, "utf-8"))).toEqual({
      cookies: [{ name: "cf_clearance", value: "nuevo" }],
    });
  });
});

describe("BrowserClient.renewSession", () => {
  it("relanza el login aunque ya exista un storageState previo", async () => {
    const storageStatePath = join(dir, "storageState.json");
    writeFileSync(storageStatePath, JSON.stringify({ cookies: [{ name: "cf_clearance", value: "viejo" }] }));

    const { browser } = fakeBrowser();
    const launch = vi.fn().mockResolvedValue(browser);
    const client = new BrowserClient({ storageStatePath, launch });

    await client.renewSession();

    expect(launch).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(storageStatePath, "utf-8"))).toEqual({
      cookies: [{ name: "cf_clearance", value: "nuevo" }],
    });
  });

  it("devuelve blocked si el login nunca completa (timeout esperando a la persona)", async () => {
    const storageStatePath = join(dir, "storageState.json");
    const { browser } = fakeBrowser({
      waitForURL: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const launch = vi.fn().mockResolvedValue(browser);

    const client = new BrowserClient({ storageStatePath, launch });
    const result = await client.renewSession();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("blocked");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(existsSync(storageStatePath)).toBe(false);
  });

  it("devuelve blocked si el navegador ni siquiera arranca", async () => {
    const storageStatePath = join(dir, "storageState.json");
    const launch = vi.fn().mockRejectedValue(new Error("no chromium instalado"));

    const client = new BrowserClient({ storageStatePath, launch });
    const result = await client.renewSession();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("blocked");
  });
});
