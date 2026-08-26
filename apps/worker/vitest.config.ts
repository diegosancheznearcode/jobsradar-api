import { defineConfig } from "vitest/config";

// Los tests de los processors comparten una sola base Postgres real (sin
// mock — sección 11 no cubre SQL, y mockear postgres.js no probaría nada
// útil). Cada archivo hace TRUNCATE en beforeEach; correrlos en paralelo
// hace que un archivo borre los datos que otro acaba de insertar.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
