import { err, ok } from "@jobsradar/domain";
import type { ExtractionError, Result } from "@jobsradar/domain";
import { buildCookieHeader, loadStorageState } from "./session.js";

// fetch + cookies de sesión + espaciado/jitter — ver ARCHITECTURE.md
// sección 6.2. Política de ritmo confirmada: 6-10s de espaciado con jitter,
// 3 reintentos con backoff exponencial. No hay evasión de fingerprint
// (AD-09): los headers son los mismos que confirmaron acceso en Fase 0, no
// se rota nada por request.

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface HttpClientOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  storageStatePath?: string;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetchImpl?: typeof fetch;
}

export interface HttpGetOptions {
  // La mayoría de las rutas no necesitan sesión (Fase 0): solo
  // /company/{slug} pasa por Cloudflare. Explícito por request, no un
  // default global, para no mandar cookies donde no hacen falta.
  withSession?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetries: number;
  private readonly storageStatePath: string | undefined;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(options: HttpClientOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? 6000;
    this.maxDelayMs = options.maxDelayMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.storageStatePath = options.storageStatePath;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(url: string, options: HttpGetOptions = {}): Promise<Result<string, ExtractionError>> {
    await this.waitForRateLimit();
    return this.attemptWithRetries(url, options, 0);
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.lastRequestAt === 0) {
      this.lastRequestAt = Date.now();
      return;
    }
    const target = this.minDelayMs + this.random() * (this.maxDelayMs - this.minDelayMs);
    const elapsed = Date.now() - this.lastRequestAt;
    const remaining = target - elapsed;
    if (remaining > 0) {
      await this.sleep(remaining);
    }
    this.lastRequestAt = Date.now();
  }

  private buildHeaders(options: HttpGetOptions): Headers {
    const headers = new Headers({
      "User-Agent": this.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    });

    if (options.withSession && this.storageStatePath) {
      const state = loadStorageState(this.storageStatePath);
      if (state) {
        const cookieHeader = buildCookieHeader(state.cookies);
        if (cookieHeader) headers.set("Cookie", cookieHeader);
      }
    }

    return headers;
  }

  private async attemptWithRetries(
    url: string,
    options: HttpGetOptions,
    attempt: number,
  ): Promise<Result<string, ExtractionError>> {
    const result = await this.attemptOnce(url, options);
    if (result.ok) return result;

    const shouldRetry = result.error.kind === "rate_limited" && attempt < this.maxRetries;
    if (!shouldRetry) return result;

    const backoff = 1000 * 2 ** attempt + this.random() * 1000;
    await this.sleep(backoff);
    return this.attemptWithRetries(url, options, attempt + 1);
  }

  private async attemptOnce(url: string, options: HttpGetOptions): Promise<Result<string, ExtractionError>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: this.buildHeaders(options) });
    } catch {
      // Fallo de red (DNS, conexión, timeout) — el kind más cercano de los
      // 4 que define ARCHITECTURE.md sección 4.2 es rate_limited: es
      // retryable y "probá de nuevo más tarde" es la acción correcta,
      // aunque no sea literalmente un 429.
      return err({ kind: "rate_limited", retryable: true, retryAfterMs: 5000 });
    }

    // Cf-Mitigated: challenge es la señal exacta que confirmó Fase 0 en
    // /company/{slug} sin sesión. Un 403 sin ese header no se asume bloqueo
    // (podría ser otra cosa) — cae a not_found más abajo.
    if (response.status === 403 && response.headers.get("cf-mitigated") !== null) {
      return err({
        kind: "blocked",
        retryable: true,
        detail: `403 Cf-Mitigated: ${response.headers.get("cf-mitigated")}`,
      });
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 5000;
      return err({ kind: "rate_limited", retryable: true, retryAfterMs });
    }

    if (response.status >= 500) {
      return err({ kind: "rate_limited", retryable: true, retryAfterMs: 5000 });
    }

    if (!response.ok) {
      return err({ kind: "not_found", retryable: false });
    }

    return ok(await response.text());
  }
}
