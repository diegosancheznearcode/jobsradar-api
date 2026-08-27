#!/usr/bin/env node
// Issue #13 — mide cuánto dura viva una sesión de Wellfound (cf_clearance +
// cookies asociadas) antes de que Cloudflare vuelva a pedir challenge.
//
// Corre en tu máquina, no en CI ni en ningún servicio: la cookie nunca se
// commitea ni se le pasa a un LLM. Se lee de la variable de entorno
// WELLFOUND_COOKIE la primera vez y se cachea en scripts/.cf-cookie
// (gitignored) para no tener que volver a pegarla en cada corrida.
//
// Uso:
//   WELLFOUND_COOKIE="cf_clearance=...; _wellfound=...; ..." node scripts/measure-cf-clearance-ttl.mjs
//   node scripts/measure-cf-clearance-ttl.mjs                 # reusa scripts/.cf-cookie si ya existe
//   node scripts/measure-cf-clearance-ttl.mjs --interval 15   # minutos entre chequeos (default 30)
//
// Prueba GET /company/vaulfi-1 (confirmado en Fase 0: 403 + Cf-Mitigated:
// challenge sin sesión, 200 con estado hidratado completo con sesión válida
// — ver ARCHITECTURE.md sección 12, Fase 0 punto 6). Loguea cada chequeo en
// scripts/cf-clearance-ttl.log (gitignored, *.log) y corta apenas detecta
// que la sesión dejó de servir, reportando el TTL observado.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIE_CACHE_PATH = join(__dirname, ".cf-cookie");
const LOG_PATH = join(__dirname, "cf-clearance-ttl.log");
const TARGET_URL = "https://wellfound.com/company/vaulfi-1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const intervalIdx = argv.indexOf("--interval");
  const intervalMinutes = intervalIdx !== -1 ? Number(argv[intervalIdx + 1]) : 30;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error("--interval debe ser un número de minutos > 0");
  }
  return { intervalMinutes };
}

function resolveCookie() {
  const fromEnv = process.env.WELLFOUND_COOKIE;
  if (fromEnv && fromEnv.trim().length > 0) {
    writeFileSync(COOKIE_CACHE_PATH, fromEnv.trim(), "utf8");
    return fromEnv.trim();
  }
  if (existsSync(COOKIE_CACHE_PATH)) {
    return readFileSync(COOKIE_CACHE_PATH, "utf8").trim();
  }
  throw new Error(
    "No hay cookie. Pasala la primera vez con WELLFOUND_COOKIE=\"...\" node scripts/measure-cf-clearance-ttl.mjs",
  );
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, stamped + "\n", "utf8");
}

async function checkSession(cookie) {
  const res = await fetch(TARGET_URL, {
    headers: {
      Cookie: cookie,
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "manual",
  });

  const cfMitigated = res.headers.get("cf-mitigated");
  const body = res.status === 200 ? await res.text() : "";
  const looksAuthenticated = res.status === 200 && body.includes("__NEXT_DATA__") && !body.includes("Just a moment");

  return {
    status: res.status,
    cfMitigated,
    ok: looksAuthenticated,
  };
}

async function main() {
  const { intervalMinutes } = parseArgs(process.argv.slice(2));
  const cookie = resolveCookie();
  const startedAt = Date.now();

  log(`Arranca medición de TTL. Chequeo cada ${intervalMinutes} min contra ${TARGET_URL}.`);

  // Primer chequeo inmediato — confirma que la cookie sirve antes de
  // empezar a esperar.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let result;
    try {
      result = await checkSession(cookie);
    } catch (err) {
      log(`Error de red, reintento en el próximo ciclo: ${err.message}`);
      await sleep(intervalMinutes * 60_000);
      continue;
    }

    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);

    if (result.ok) {
      log(`OK (200, autenticado) — ${elapsedMin} min desde el arranque.`);
    } else {
      log(
        `SESIÓN CAÍDA — status=${result.status} cf-mitigated=${result.cfMitigated ?? "-"} ` +
          `después de ${elapsedMin} min (~${(elapsedMin / 60).toFixed(1)} h) desde el arranque.`,
      );
      log(`TTL observado: ~${elapsedMin} minutos. Ver ${LOG_PATH} para el detalle completo.`);
      process.exit(0);
    }

    await sleep(intervalMinutes * 60_000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
