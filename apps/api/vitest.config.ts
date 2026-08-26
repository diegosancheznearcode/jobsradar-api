import { defineConfig } from "vitest/config";

// El primer test paga el costo de import (fastify, ioredis, postgres.js) +
// la primera conexión a Postgres — en este entorno eso solo ya se come el
// timeout default de 5s. Ver el mismo ajuste en jobsradar-web.
export default defineConfig({
  test: {
    testTimeout: 20000,
  },
});
