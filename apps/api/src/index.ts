import cors from "@fastify/cors";
import Fastify from "fastify";

// Contrato completo (rutas + SSE) en ARCHITECTURE.md sección 7.
// Las rutas devuelven 501 hasta la Fase 6 — este archivo solo confirma que
// el servicio arranca, responde y aplica CORS por entorno (AD-11, sección 7.1).

const PORT = Number(process.env.PORT ?? 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: ALLOWED_ORIGINS,
});

app.get("/health", async () => ({ status: "ok" }));

app.post("/api/searches", async (_request, reply) => {
  return reply.code(501).send({ error: "not_implemented", phase: 6 });
});

app.get("/api/searches/:id", async (_request, reply) => {
  return reply.code(501).send({ error: "not_implemented", phase: 6 });
});

app.get("/api/searches/:id/stream", async (_request, reply) => {
  return reply.code(501).send({ error: "not_implemented", phase: 6 });
});

app.get("/api/searches/:id/export", async (_request, reply) => {
  return reply.code(501).send({ error: "not_implemented", phase: 6 });
});

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
