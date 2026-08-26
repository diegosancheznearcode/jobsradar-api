import type { Company, SearchCriteria } from "@diegosancheznearcode/contracts";
import { CompanySchema } from "@diegosancheznearcode/contracts";
import type { SearchRepositoryPort, SearchSnapshot } from "@jobsradar/domain";
import type postgres from "postgres";

// Implementa SearchRepositoryPort — ver ARCHITECTURE.md sección 5 y 8.
// Sin ORM (AD-07): queries explícitas con postgres.js.

interface CompanyRow {
  id: string;
  slug: string;
  name: string;
  pitch: string | null;
  size: string | null;
  market: string | null;
  website_url: string | null;
  wellfound_url: string;
  extraction_strategy: string;
  extraction_confidence: number;
  extraction_missing: string[];
}

interface FounderRow {
  name: string;
  role: string | null;
  profile_url: string | null;
  linkedin_url: string | null;
  source: string;
}

interface JobRow {
  external_id: string;
  title: string;
  location: string | null;
  is_remote: boolean;
  apply_url: string;
  posted_at: Date | null;
}

// perPage confirmado en Fase 0 (sección 12) — se usa acá solo para
// aproximar `progress.page` en getSnapshot; search_results no guarda en
// qué página se descubrió cada empresa.
const CONFIRMED_PER_PAGE = 20;

export class PostgresSearchRepository implements SearchRepositoryPort {
  constructor(private readonly sql: postgres.Sql) {}

  async create(criteria: SearchCriteria): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO searches (job_title, location, remote_only, target_companies, status)
      VALUES (
        ${criteria.jobTitle},
        ${criteria.location ?? null},
        ${criteria.remoteOnly},
        ${criteria.targetCompanies},
        'queued'
      )
      RETURNING id
    `;
    if (!row) throw new Error("INSERT INTO searches no devolvió una fila");
    return row.id;
  }

  async updateStatus(searchId: string, status: SearchSnapshot["status"]): Promise<void> {
    await this.sql`UPDATE searches SET status = ${status} WHERE id = ${searchId}`;
  }

  async attachCompany(searchId: string, company: Company, rank: number): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [companyRow] = await tx<{ id: string }[]>`
        INSERT INTO companies (
          slug, name, pitch, size, market, website_url, wellfound_url,
          extraction_strategy, extraction_confidence, extraction_missing, scraped_at
        )
        VALUES (
          ${company.slug}, ${company.name}, ${company.pitch}, ${company.size},
          ${company.market}, ${company.websiteUrl}, ${company.wellfoundUrl},
          ${company.extraction.strategy}, ${company.extraction.confidence},
          ${company.extraction.missing}, now()
        )
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          -- Merge no destructivo: un attachCompany posterior con datos
          -- parciales (ej. desde el listado) no debe pisar con null lo que
          -- una llamada anterior con más datos (ej. el perfil) ya sabía.
          pitch = COALESCE(EXCLUDED.pitch, companies.pitch),
          size = COALESCE(EXCLUDED.size, companies.size),
          market = COALESCE(EXCLUDED.market, companies.market),
          website_url = COALESCE(EXCLUDED.website_url, companies.website_url),
          wellfound_url = EXCLUDED.wellfound_url,
          extraction_strategy = EXCLUDED.extraction_strategy,
          extraction_confidence = EXCLUDED.extraction_confidence,
          extraction_missing = EXCLUDED.extraction_missing,
          scraped_at = now()
        RETURNING id
      `;
      if (!companyRow) throw new Error("INSERT INTO companies no devolvió una fila");
      const companyId = companyRow.id;

      // Founders solo se reemplazan cuando esta llamada trae founders de
      // verdad — así una llamada parcial (sin founders) no borra los que
      // ya se habían encontrado.
      if (company.founders.length > 0) {
        await tx`DELETE FROM founders WHERE company_id = ${companyId}`;
        for (const founder of company.founders) {
          await tx`
            INSERT INTO founders (company_id, name, role, profile_url, linkedin_url, source, fetched_at)
            VALUES (
              ${companyId}, ${founder.name}, ${founder.role},
              ${founder.profileUrl}, ${founder.linkedinUrl}, ${founder.source}, now()
            )
          `;
        }
      }

      for (const job of company.jobs) {
        await tx`
          INSERT INTO job_postings (company_id, external_id, title, location, is_remote, apply_url, posted_at)
          VALUES (
            ${companyId}, ${job.externalId}, ${job.title}, ${job.location},
            ${job.isRemote}, ${job.applyUrl}, ${job.postedAt}
          )
          ON CONFLICT (company_id, external_id) DO UPDATE SET
            title = EXCLUDED.title,
            location = EXCLUDED.location,
            is_remote = EXCLUDED.is_remote,
            apply_url = EXCLUDED.apply_url,
            posted_at = EXCLUDED.posted_at
        `;
      }

      // Idempotencia (searchId, slug) — sección 10: un reintento nunca
      // duplica una fila.
      await tx`
        INSERT INTO search_results (search_id, company_id, rank)
        VALUES (${searchId}, ${companyId}, ${rank})
        ON CONFLICT (search_id, company_id) DO NOTHING
      `;
    });
  }

  async findCompanyBySlug(slug: string, maxAgeHours: number): Promise<Company | null> {
    const rows = await this.sql<CompanyRow[]>`
      SELECT * FROM companies
      WHERE slug = ${slug}
        AND scraped_at > now() - (${maxAgeHours} || ' hours')::interval
    `;
    const row = rows[0];
    if (!row) return null;
    return this.hydrateCompany(row);
  }

  async getSnapshot(searchId: string): Promise<SearchSnapshot> {
    const [search] = await this.sql<{ status: string; target_companies: number }[]>`
      SELECT status, target_companies FROM searches WHERE id = ${searchId}
    `;
    if (!search) throw new Error(`search ${searchId} no existe`);

    const companyRows = await this.sql<CompanyRow[]>`
      SELECT c.* FROM companies c
      JOIN search_results sr ON sr.company_id = c.id
      WHERE sr.search_id = ${searchId}
      ORDER BY sr.rank ASC
    `;

    const companies = await Promise.all(companyRows.map((row) => this.hydrateCompany(row)));
    const found = companies.length;

    return {
      status: search.status as SearchSnapshot["status"],
      progress: {
        found,
        target: search.target_companies,
        // Aproximado — ver comentario de CONFIRMED_PER_PAGE arriba.
        page: Math.ceil(found / CONFIRMED_PER_PAGE),
      },
      companies,
    };
  }

  private async hydrateCompany(row: CompanyRow): Promise<Company> {
    const founderRows = await this.sql<FounderRow[]>`
      SELECT name, role, profile_url, linkedin_url, source
      FROM founders WHERE company_id = ${row.id}
    `;
    const jobRows = await this.sql<JobRow[]>`
      SELECT external_id, title, location, is_remote, apply_url, posted_at
      FROM job_postings WHERE company_id = ${row.id}
    `;

    return CompanySchema.parse({
      slug: row.slug,
      name: row.name,
      pitch: row.pitch,
      size: row.size,
      market: row.market,
      websiteUrl: row.website_url,
      wellfoundUrl: row.wellfound_url,
      founders: founderRows.map((f) => ({
        name: f.name,
        role: f.role,
        profileUrl: f.profile_url,
        linkedinUrl: f.linkedin_url,
        source: f.source,
      })),
      jobs: jobRows.map((j) => ({
        externalId: j.external_id,
        title: j.title,
        location: j.location,
        isRemote: j.is_remote,
        applyUrl: j.apply_url,
        postedAt: j.posted_at,
      })),
      extraction: {
        strategy: row.extraction_strategy,
        confidence: row.extraction_confidence,
        missing: row.extraction_missing,
      },
    });
  }
}
