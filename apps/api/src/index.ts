import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { subscribeToSearch } from "@jobsradar/events-redis";
import { createConnection, PostgresSearchRepository, runMigrations } from "@jobsradar/repository-postgres";
import { buildApp } from "./app.js";

// Contrato completo (rutas + SSE) en ARCHITECTURE.md sección 7.

const PORT = Number(process.env.PORT ?? 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5174")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jobsradar:jobsradar@localhost:5432/jobsradar";

const sql = createConnection(DATABASE_URL);
await runMigrations(sql);
const repository = new PostgresSearchRepository(sql);

const queueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const searchListQueue = new Queue("search-list", { connection: queueConnection });

const app = buildApp({
  repository,
  allowedOrigins: ALLOWED_ORIGINS,
  enqueueSearchList: (data) => searchListQueue.add("page", data).then(() => undefined),
  subscribeToSearch: (searchId, onEvent) => subscribeToSearch(REDIS_URL, searchId, onEvent),
});

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
