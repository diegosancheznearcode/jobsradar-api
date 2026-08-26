import type { ExtractionError } from "@jobsradar/domain";

// Circuit breaker global — ver ARCHITECTURE.md sección 6.2 y AD-09: "pausa
// toda la búsqueda al primer captcha". No hay evasión de fingerprint; ante
// un bloqueo, el breaker se abre y todo lo que pase por WellfoundAdapter
// devuelve el mismo error sin volver a golpear la red, hasta que algo
// externo (una sesión renovada vía BrowserClient) lo resetee.

export type CircuitBreakerState = "closed" | "open";

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private lastError: ExtractionError | null = null;

  isOpen(): boolean {
    return this.state === "open";
  }

  trip(error: ExtractionError): void {
    this.state = "open";
    this.lastError = error;
  }

  reset(): void {
    this.state = "closed";
    this.lastError = null;
  }

  getLastError(): ExtractionError | null {
    return this.lastError;
  }
}
