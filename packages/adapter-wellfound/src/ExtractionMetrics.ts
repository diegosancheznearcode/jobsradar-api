// Alerta operativa — ver ARCHITECTURE.md sección 11: "si la tasa de
// extracción vacía supera el 30 %, los selectores se rompieron. Es el
// síntoma que hay que monitorear."
//
// "Extracción vacía" es específicamente `parse_failed` — la cascada de
// estrategias (sección 6.1) se quedó sin nada que extraer con un HTML que
// SÍ llegó (200 OK). `blocked`/`rate_limited`/`not_found` no cuentan acá:
// son problemas de acceso a la red, no de selectores rotos, y ya los
// cubre el circuit breaker (AD-09).

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MIN_SAMPLES = 5; // evita alertar con 1 de 1 fallido al arrancar
const DEFAULT_THRESHOLD = 0.3;

export class ExtractionMetrics {
  private readonly window: boolean[] = []; // true = parseó bien, false = parse_failed

  constructor(
    private readonly windowSize: number = DEFAULT_WINDOW_SIZE,
    private readonly minSamples: number = DEFAULT_MIN_SAMPLES,
    private readonly threshold: number = DEFAULT_THRESHOLD,
  ) {}

  record(success: boolean): void {
    this.window.push(success);
    if (this.window.length > this.windowSize) this.window.shift();
  }

  get sampleSize(): number {
    return this.window.length;
  }

  failureRate(): number {
    if (this.window.length === 0) return 0;
    const failures = this.window.filter((s) => !s).length;
    return failures / this.window.length;
  }

  isAboveThreshold(): boolean {
    return this.window.length >= this.minSamples && this.failureRate() > this.threshold;
  }
}
