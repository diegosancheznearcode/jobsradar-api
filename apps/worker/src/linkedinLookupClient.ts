// Pedido explícito del usuario: cuando Wellfound no trae el LinkedIn de una
// empresa (CompanyProfileParser confirmó en Fase 0 que /company/{slug}/people
// no lo expone), se consulta como fallback
// https://talentradar-api-tnxrhfijdq-pv.a.run.app/api/empresa-linkedin —
// un servicio propio del usuario que busca "<dominio> site:linkedin.com/
// company/" y devuelve el linkedin_url que encuentre. Requiere un token
// (POST /api/auth/token con usuario/password) que vence a la hora — este
// cliente lo cachea y lo renueva solo, no en cada consulta.
//
// Es un enriquecimiento OPCIONAL: si el servicio está caído, da timeout, o
// no encuentra nada, se degrada a linkedinUrl=null (como ya pasaba antes de
// este fallback) — nunca debe tirar abajo el enriquecimiento de la empresa
// (sección 1.3).

const DEFAULT_BASE_URL = "https://talentradar-api-tnxrhfijdq-pv.a.run.app";
// Renovar un minuto antes de que venza el token, no justo al límite — evita
// una carrera donde el token expira entre que se lee y que se usa.
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export interface LinkedinLookupClientDeps {
  usuario: string;
  password: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export class LinkedinLookupClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly deps: LinkedinLookupClientDeps) {
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? console.warn;
  }

  async findLinkedinUrl(websiteUrl: string): Promise<string | null> {
    try {
      const token = await this.getToken();
      const response = await this.fetchImpl(`${this.baseUrl}/api/empresa-linkedin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url_empresa: websiteUrl }),
      });

      if (!response.ok) {
        this.log(`[linkedin-lookup] empresa-linkedin respondió ${response.status} para ${websiteUrl}`);
        return null;
      }

      const data = (await response.json()) as { linkedin_url?: unknown };
      if (typeof data.linkedin_url !== "string") return null;

      try {
        new URL(data.linkedin_url);
      } catch {
        this.log(`[linkedin-lookup] linkedin_url inválida para ${websiteUrl}: ${data.linkedin_url}`);
        return null;
      }

      return data.linkedin_url;
    } catch (err) {
      this.log(
        `[linkedin-lookup] fallo consultando ${websiteUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const response = await this.fetchImpl(`${this.baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: this.deps.usuario, password: this.deps.password }),
    });
    if (!response.ok) {
      throw new Error(`auth/token respondió ${response.status}`);
    }

    const data = (await response.json()) as { token: string; expires_in?: string };
    this.token = data.token;
    this.tokenExpiresAt = Date.now() + parseExpiresIn(data.expires_in) - TOKEN_SAFETY_MARGIN_MS;
    return this.token;
  }
}

// "1h" es el formato observado del servicio real (también soporta "m"/"s"
// por si cambia). Un formato no reconocido se trata como "ya vencido" —
// fuerza a pedir un token nuevo la próxima vez en vez de cachear algo por
// un tiempo que no se pudo interpretar.
function parseExpiresIn(expiresIn: string | undefined): number {
  const match = /^(\d+)(h|m|s)$/.exec(expiresIn ?? "");
  if (!match) return 0;
  const value = Number(match[1]);
  const multiplier = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000;
  return value * multiplier;
}
