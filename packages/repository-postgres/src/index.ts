import postgres from "postgres";

export { PostgresSearchRepository } from "./PostgresSearchRepository.js";
export { runMigrations } from "./migrate.js";

export function createConnection(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl);
}
