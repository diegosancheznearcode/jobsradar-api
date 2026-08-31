import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { SearchCriteriaSchema } from "@diegosancheznearcode/contracts";
import type { SearchRepositoryPort } from "@jobsradar/domain";
import { companiesToCsv, filterCompaniesByLocation } from "./csv.js";

// Contrato completo en ARCHITECTURE.md sección 7. buildApp() separa la
// configuración de Fastify del arranque real (index.ts) para poder testear
// las rutas con fastify.inject(), sin bindear un puerto.

export interface BuildAppOptions {
  repository: SearchRepositoryPort;
  allowedOrigins: string[];
  enqueueSearchList: (data: { searchId: string; criteria: unknown; page: number }) => Promise<void>;
  subscribeToSearch: (searchId: string, onEvent: (event: unknown) => void) => () => void;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: options.allowedOrigins });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/searches", async (request, reply) => {
    const parsed = SearchCriteriaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_criteria", details: parsed.error.issues });
    }

    const searchId = await options.repository.create(parsed.data);
    await options.enqueueSearchList({ searchId, criteria: parsed.data, page: 1 });

    return reply.code(202).send({ searchId });
  });

  app.get<{ Params: { id: string } }>("/api/searches/:id", async (request, reply) => {
    try {
      const snapshot = await options.repository.getSnapshot(request.params.id);
      return reply.send(snapshot);
    } catch {
      return reply.code(404).send({ error: "search_not_found" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/searches/:id/stream", (request, reply) => {
    // reply.raw.writeHead() evita el ciclo de reply de Fastify por completo
    // (necesario para poder ir escribiendo eventos a medida que llegan), así
    // que el hook onSend de @fastify/cors nunca corre acá — a diferencia del
    // resto de las rutas, que sí usan reply.send()/reply.header(). Sin este
    // header a mano, el navegador bloquea el EventSource por CORS aunque
    // origin esté en allowedOrigins (bug real encontrado probando la UI).
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    const origin = request.headers.origin;
    if (origin && options.allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    reply.raw.writeHead(200, headers);

    // Solo "error" cierra acá — un "done" significa que search-list terminó
    // de paginar (sección 10), pero company-detail/job-detail pueden seguir
    // enriqueciendo empresas ya encontradas en segundo plano durante varios
    // minutos más (rate-limit de 6-10s por request, Fase 4). Cerrar el
    // stream al ver "done" (como hacía antes) descartaba en silencio todo
    // company.updated que llegara después — bug real reportado por el
    // usuario ("la página trae unos datos, el export otros": el export lee
    // Postgres directo, la tabla solo se entera por este stream). El
    // cliente decide cuándo dejar de escuchar (unmount, nueva búsqueda) vía
    // request.raw.on("close") de abajo.
    const unsubscribe = options.subscribeToSearch(request.params.id, (event) => {
      const payload = event as { type: string };
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (payload.type === "error") {
        unsubscribe();
        reply.raw.end();
      }
    });

    request.raw.on("close", unsubscribe);
  });

  // ?location= es el mismo filtro que ResultsTable aplica en pantalla
  // (jobsradar-web) — sin esto, "lo que ves" y "lo que exportás" no
  // coinciden: bug real reportado por el usuario probando la UI (sección
  // 9.1 resultado Fase 11).
  app.get<{ Params: { id: string }; Querystring: { location?: string } }>(
    "/api/searches/:id/export",
    async (request, reply) => {
      try {
        const snapshot = await options.repository.getSnapshot(request.params.id);
        const companies = filterCompaniesByLocation(snapshot.companies, request.query.location);
        const csv = companiesToCsv(companies);
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="jobsradar-${request.params.id}.csv"`)
          .send(csv);
      } catch {
        return reply.code(404).send({ error: "search_not_found" });
      }
    },
  );

  return app;
}
