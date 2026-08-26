import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { SearchCriteriaSchema } from "@jobsradar/contracts";
import type { SearchRepositoryPort } from "@jobsradar/domain";
import { companiesToCsv } from "./csv.js";

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
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const unsubscribe = options.subscribeToSearch(request.params.id, (event) => {
      const payload = event as { type: string };
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (payload.type === "done" || payload.type === "error") {
        unsubscribe();
        reply.raw.end();
      }
    });

    request.raw.on("close", unsubscribe);
  });

  app.get<{ Params: { id: string } }>("/api/searches/:id/export", async (request, reply) => {
    try {
      const snapshot = await options.repository.getSnapshot(request.params.id);
      const csv = companiesToCsv(snapshot.companies);
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="jobsradar-${request.params.id}.csv"`)
        .send(csv);
    } catch {
      return reply.code(404).send({ error: "search_not_found" });
    }
  });

  return app;
}
