// Result Object y errores de extracción — ver ARCHITECTURE.md sección 4.2.
// `blocked` y `rate_limited` disparan el circuit breaker. `parse_failed`
// guarda el HTML como fixture candidata y sigue.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ExtractionError =
  | { kind: "blocked"; retryable: true; detail: string }
  | { kind: "not_found"; retryable: false }
  | { kind: "parse_failed"; retryable: false; strategy: string; html: string }
  | { kind: "rate_limited"; retryable: true; retryAfterMs: number };

// Constructores — no están en el documento, pero sin ellos Result<T, E> es
// incómodo de producir en cada call site. Mantiene el patrón consistente.
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
