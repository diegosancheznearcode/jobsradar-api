import * as cheerio from "cheerio";

// Extractores de bajo nivel compartidos por los parsers — ver
// ARCHITECTURE.md sección 6.1 (estrategias json_ld / hydrated_state).

// Todas las páginas de Wellfound observadas en Fase 0 exponen el estado
// hidratado como un <script id="__NEXT_DATA__"> con un cache Apollo
// normalizado en props.pageProps.apolloState.data.
export function parseNextData(html: string): unknown | null {
  const $ = cheerio.load(html);
  const raw = $("script#__NEXT_DATA__").first().text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getApolloState(nextData: unknown): Record<string, any> | null {
  const data = (nextData as any)?.props?.pageProps?.apolloState?.data;
  return data && typeof data === "object" ? data : null;
}

// Resuelve un { __ref } de Apollo contra el cache normalizado.
export function resolveRef(apollo: Record<string, any>, ref: { __ref: string } | undefined): any | null {
  if (!ref) return null;
  return apollo[ref.__ref] ?? null;
}

// application/ld+json — puede haber más de uno en una página; Fase 0 solo
// encontró un JobPosting por página de detalle de vacante, así que se toma
// el primero.
export function parseJsonLd(html: string): unknown | null {
  const $ = cheerio.load(html);
  const raw = $('script[type="application/ld+json"]').first().text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getCanonicalUrl(html: string): string | null {
  const $ = cheerio.load(html);
  const href = $('link[rel="canonical"]').first().attr("href");
  return href ?? null;
}
