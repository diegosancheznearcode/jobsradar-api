import { existsSync, readFileSync } from "node:fs";

// Formato storageState de Playwright — ver ARCHITECTURE.md sección 6.2.
// Solo se leen los campos que hacen falta para construir el header Cookie;
// no se re-implementa el formato completo de Playwright.

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface StorageState {
  cookies: StorageStateCookie[];
}

export function loadStorageState(path: string): StorageState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as StorageState;
    return Array.isArray(parsed.cookies) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildCookieHeader(cookies: StorageStateCookie[], domain = "wellfound.com"): string {
  return cookies
    .filter((c) => c.domain.endsWith(domain))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
