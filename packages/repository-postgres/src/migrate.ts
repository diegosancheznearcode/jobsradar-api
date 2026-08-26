import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";

// Runner de migraciones minimalista — sin ORM (AD-07), sin herramienta de
// migraciones externa. Aplica los .sql de migrations/ en orden alfabético,
// registrando cuáles ya corrieron en schema_migrations.

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

export async function runMigrations(sql: postgres.Sql): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const contents = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    newlyApplied.push(file);
  }

  return newlyApplied;
}
