import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./CircuitBreaker.js";

describe("CircuitBreaker", () => {
  it("empieza cerrado", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getLastError()).toBeNull();
  });

  it("trip() lo abre y guarda el error", () => {
    const breaker = new CircuitBreaker();
    breaker.trip({ kind: "blocked", retryable: true, detail: "captcha" });

    expect(breaker.isOpen()).toBe(true);
    expect(breaker.getLastError()).toEqual({ kind: "blocked", retryable: true, detail: "captcha" });
  });

  it("reset() lo vuelve a cerrar", () => {
    const breaker = new CircuitBreaker();
    breaker.trip({ kind: "blocked", retryable: true, detail: "captcha" });
    breaker.reset();

    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getLastError()).toBeNull();
  });

  it("getMetrics expone tripCount y lastTrippedAt", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getMetrics()).toEqual({
      state: "closed",
      tripCount: 0,
      lastTrippedAt: null,
      lastError: null,
    });

    breaker.trip({ kind: "blocked", retryable: true, detail: "captcha" });
    const metrics = breaker.getMetrics();
    expect(metrics.state).toBe("open");
    expect(metrics.tripCount).toBe(1);
    expect(metrics.lastTrippedAt).toBeInstanceOf(Date);
  });

  it("tripCount es acumulativo: reset() no lo reinicia", () => {
    const breaker = new CircuitBreaker();
    breaker.trip({ kind: "blocked", retryable: true, detail: "captcha" });
    breaker.reset();
    breaker.trip({ kind: "blocked", retryable: true, detail: "otro captcha" });

    expect(breaker.getMetrics().tripCount).toBe(2);
  });
});
