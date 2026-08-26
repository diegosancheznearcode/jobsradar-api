import { describe, expect, it } from "vitest";
import { ExtractionMetrics } from "./ExtractionMetrics.js";

describe("ExtractionMetrics", () => {
  it("failureRate 0 cuando no hay muestras todavía", () => {
    const metrics = new ExtractionMetrics();
    expect(metrics.failureRate()).toBe(0);
    expect(metrics.isAboveThreshold()).toBe(false);
  });

  it("calcula la tasa de fallos sobre las muestras registradas", () => {
    const metrics = new ExtractionMetrics(20, 5, 0.3);
    for (const ok of [true, true, true, false, false]) metrics.record(ok);

    expect(metrics.sampleSize).toBe(5);
    expect(metrics.failureRate()).toBe(0.4);
    expect(metrics.isAboveThreshold()).toBe(true);
  });

  it("no alerta por debajo de minSamples aunque el 100% haya fallado", () => {
    const metrics = new ExtractionMetrics(20, 5, 0.3);
    metrics.record(false);
    metrics.record(false);

    expect(metrics.failureRate()).toBe(1);
    expect(metrics.isAboveThreshold()).toBe(false);
  });

  it("no alerta exactamente en el umbral, solo por encima", () => {
    const metrics = new ExtractionMetrics(10, 5, 0.3);
    for (const ok of [true, true, true, true, true, true, false, false, false]) metrics.record(ok);
    // 3/9 = 0.333... > 0.3
    expect(metrics.isAboveThreshold()).toBe(true);

    const metricsAtThreshold = new ExtractionMetrics(10, 5, 0.4);
    for (const ok of [true, true, true, false, false]) metricsAtThreshold.record(ok);
    // 2/5 = 0.4, no > 0.4
    expect(metricsAtThreshold.isAboveThreshold()).toBe(false);
  });

  it("es una ventana móvil: descarta muestras viejas más allá de windowSize", () => {
    const metrics = new ExtractionMetrics(5, 5, 0.3);
    for (const ok of [false, false, false, false, false]) metrics.record(ok);
    expect(metrics.failureRate()).toBe(1);

    for (const ok of [true, true, true, true, true]) metrics.record(ok);
    expect(metrics.sampleSize).toBe(5);
    expect(metrics.failureRate()).toBe(0);
  });
});
