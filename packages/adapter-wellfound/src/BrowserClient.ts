import { existsSync, writeFileSync } from "node:fs";
import { err, ok } from "@jobsradar/domain";
import type { ExtractionError, Result } from "@jobsradar/domain";

// Playwright, solo para login/renovación de sesión — ver ARCHITECTURE.md
// sección 6.2. Login manual una vez: esta clase abre el navegador y espera
// a que una persona complete el login, nunca automatiza credenciales.
//
// No depende del paquete `playwright` directamente — `launch` se inyecta
// desde quien construye el WellfoundAdapter real (worker), así este
// paquete no necesita el navegador instalado para typecheck/build/test.
// Fase 4 se implementó "todo mockeado" (decisión del usuario): estas
// interfaces están definidas y probadas contra fakes, pero nunca se
// ejecutaron contra un Chromium real ni contra wellfound.com — el patrón
// `postLoginUrlPattern` de abajo es una suposición razonable, no algo
// confirmado en Fase 0, y debe validarse la primera vez que esto corra en
// vivo.

export interface PageLike {
  goto(url: string): Promise<void>;
  waitForURL(pattern: RegExp, options?: { timeout?: number }): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

export interface BrowserClientOptions {
  storageStatePath: string;
  launch: () => Promise<BrowserLike>;
  loginUrl?: string;
  // Sin confirmar contra Wellfound real — ver nota arriba.
  postLoginUrlPattern?: RegExp;
  loginTimeoutMs?: number;
}

const DEFAULT_LOGIN_URL = "https://wellfound.com/login";
const DEFAULT_POST_LOGIN_PATTERN = /^https:\/\/wellfound\.com\/(?!login)/;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class BrowserClient {
  constructor(private readonly options: BrowserClientOptions) {}

  // Login solo si todavía no hay storageState en disco. No valida si ese
  // archivo sigue siendo válido (eso lo decide el circuit breaker cuando
  // HttpClient devuelve `blocked`) — ver WellfoundAdapter.
  async ensureSession(): Promise<Result<{ storageStatePath: string }, ExtractionError>> {
    if (existsSync(this.options.storageStatePath)) {
      return ok({ storageStatePath: this.options.storageStatePath });
    }
    return this.renewSession();
  }

  // Siempre relanza el login interactivo, exista o no un storageState
  // previo — es lo que WellfoundAdapter llama después de que el circuit
  // breaker se abre por un `blocked`.
  async renewSession(): Promise<Result<{ storageStatePath: string }, ExtractionError>> {
    let browser: BrowserLike;
    try {
      browser = await this.options.launch();
    } catch (error) {
      return err({ kind: "blocked", retryable: true, detail: `no se pudo lanzar el navegador: ${String(error)}` });
    }

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(this.options.loginUrl ?? DEFAULT_LOGIN_URL);
      await page.waitForURL(this.options.postLoginUrlPattern ?? DEFAULT_POST_LOGIN_PATTERN, {
        timeout: this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      });

      const state = await context.storageState();
      writeFileSync(this.options.storageStatePath, JSON.stringify(state, null, 2));
      await context.close();

      return ok({ storageStatePath: this.options.storageStatePath });
    } catch (error) {
      return err({ kind: "blocked", retryable: true, detail: `login interactivo no se completó: ${String(error)}` });
    } finally {
      await browser.close();
    }
  }
}
