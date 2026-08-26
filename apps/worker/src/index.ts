import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { CircuitBreaker, HttpClient, WellfoundAdapter, parseJobDetail } from "@jobsradar/adapter-wellfound";
import { RedisEventPublisher } from "@jobsradar/events-redis";
import { createConnection, PostgresSearchRepository, runMigrations } from "@jobsradar/repository-postgres";
import { processCompanyDetail } from "./processors/companyDetailProcessor.js";
import { processJobDetail } from "./processors/jobDetailProcessor.js";
import { processSearchList } from "./processors/searchListProcessor.js";
import type { SearchListJobData } from "./processors/searchListProcessor.js";

// Consumidores BullMQ reales — ver ARCHITECTURE.md sección 10. Los
// processors (processors/*.ts) son funciones puras con dependencias
// inyectadas; este archivo solo los conecta a colas/Redis/Postgres de
// verdad.

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jobsradar:jobsradar@localhost:5432/jobsradar";
const STORAGE_STATE_PATH = process.env.WELLFOUND_STORAGE_STATE_PATH;

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const sql = createConnection(DATABASE_URL);
await runMigrations(sql);

const repository = new PostgresSearchRepository(sql);
const breaker = new CircuitBreaker();
const sessionHttp = new HttpClient(STORAGE_STATE_PATH ? { storageStatePath: STORAGE_STATE_PATH } : {});
const adapter = new WellfoundAdapter(sessionHttp, breaker);
// Conexión de publicación aparte de `connection` (BullMQ) — pub/sub y
// colas no deberían compartir la misma conexión ioredis.
const events = new RedisEventPublisher(new Redis(REDIS_URL));

// job-detail no pasa por JobSourcePort (sección 9: no lo declara) — usa su
// propio HttpClient sin sesión, tal como confirmó Fase 0.
const plainHttp = new HttpClient();
async function fetchJobDetail(url: string) {
  const htmlResult = await plainHttp.get(url);
  if (!htmlResult.ok) return htmlResult;
  return parseJobDetail(htmlResult.value);
}

const searchListQueue = new Queue<SearchListJobData>("search-list", { connection });
const companyDetailQueue = new Queue("company-detail", { connection });
const jobDetailQueue = new Queue("job-detail", { connection });

new Worker<SearchListJobData>(
  "search-list",
  (job) =>
    processSearchList(job.data, {
      adapter,
      repository,
      events,
      enqueueCompanyDetail: (data) => companyDetailQueue.add("enrich", data).then(() => undefined),
      enqueueNextPage: (data) => searchListQueue.add("page", data).then(() => undefined),
    }),
  { connection, concurrency: 1 },
);

new Worker(
  "company-detail",
  (job) => processCompanyDetail(job.data, { adapter, repository, events }),
  { connection, concurrency: 2 },
);

new Worker(
  "job-detail",
  (job) => processJobDetail(job.data, { fetchJobDetail, repository, events }),
  { connection, concurrency: 2 },
);

for (const queue of [searchListQueue, companyDetailQueue, jobDetailQueue]) {
  queue.on("error", (error) => console.error(`[${queue.name}] queue error:`, error));
}

console.log("Worker escuchando colas: search-list, job-detail, company-detail");
