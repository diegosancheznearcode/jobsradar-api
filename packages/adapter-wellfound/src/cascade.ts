import { err, ok } from "@jobsradar/domain";
import type { ExtractionError, Result } from "@jobsradar/domain";

// Cascada de extracción — ver ARCHITECTURE.md sección 6.1. Cada parser
// registra las estrategias que le aplican, en el orden json_ld ->
// hydrated_state -> css. Se devuelve el primer resultado que una estrategia
// logre extraer; si ninguna lo logra, `parse_failed`.
//
// Fase 0 confirmó un único ganador por ruta (ver sección 6.1 del documento),
// así que hoy la mayoría de los parsers solo registran una estrategia — pero
// el mecanismo soporta más de una para cuando Wellfound rediseñe.

export type ExtractionStrategyName = "json_ld" | "hydrated_state" | "css";

export interface StrategyAttempt<T> {
  strategy: ExtractionStrategyName;
  // Devuelve null (no throw) cuando esta estrategia no encuentra nada que
  // extraer en este HTML — eso es lo que hace que la cascada siga probando.
  extract: (html: string) => T | null;
}

// `data`, no `value` — evita el choque con Result<T, E>.value cuando se
// encadenan (result.value.data en vez de result.value.value).
export interface CascadeResult<T> {
  data: T;
  strategy: ExtractionStrategyName;
}

export function extractWithCascade<T>(
  html: string,
  attempts: StrategyAttempt<T>[],
): Result<CascadeResult<T>, ExtractionError> {
  for (const attempt of attempts) {
    const data = attempt.extract(html);
    if (data !== null) {
      return ok({ data, strategy: attempt.strategy });
    }
  }

  return err({
    kind: "parse_failed",
    retryable: false,
    strategy: attempts.map((a) => a.strategy).join("|"),
    html,
  });
}

// Bloqueo confirmado en Fase 0: /company/{slug} sin sesión devuelve el
// challenge de Cloudflare, no el perfil real. Un 403 con este HTML no es
// parse_failed, es blocked — ver sección 6.1 y AD-09.
const CLOUDFLARE_CHALLENGE_TITLE = "<title>Security Check | Wellfound</title>";

export function isCloudflareChallenge(html: string): boolean {
  return html.includes(CLOUDFLARE_CHALLENGE_TITLE);
}
