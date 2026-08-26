import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

// Tres colas — search-list, job-detail, company-detail — ver ARCHITECTURE.md
// sección 10. Procesadores reales (WellfoundAdapter, política de ritmo,
// circuit breaker) llegan en la Fase 4/5; esto solo confirma que el worker
// se conecta a Redis y registra las colas.

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const queueNames = ["search-list", "job-detail", "company-detail"] as const;

for (const queueName of queueNames) {
  const worker = new Worker(
    queueName,
    async (job: Job) => {
      throw new Error(
        `Procesador de "${queueName}" no implementado todavía (job ${job.id}) — ver Fase 4/5`,
      );
    },
    { connection, concurrency: 1 },
  );

  worker.on("error", (error) => {
    console.error(`[${queueName}] worker error:`, error);
  });
}

console.log(`Worker escuchando colas: ${queueNames.join(", ")}`);
