import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJobDetail } from "./JobDetailParser.js";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
const jobDetailHtml = readFileSync(join(fixturesDir, "job-detail.html"), "utf-8");

describe("parseJobDetail", () => {
  it("gana con json_ld contra el fixture real (sin red)", () => {
    const result = parseJobDetail(jobDetailHtml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.strategy).toBe("json_ld");
    }
  });

  it("extrae el JobPosting de Speak confirmado en Fase 0", () => {
    const result = parseJobDetail(jobDetailHtml);
    if (!result.ok) throw new Error("unreachable");
    const { job, company } = result.value.data;

    expect(job.title).toBe("Backend Engineer");
    expect(job.applyUrl).toBe("https://wellfound.com/jobs/3392132-backend-engineer");
    expect(job.externalId).toBe("3392132-backend-engineer");
    expect(job.isRemote).toBe(true);
    expect(job.location).toBe("San Francisco, California");
    expect(job.postedAt).toBeInstanceOf(Date);

    expect(company.name).toBe("Speak");
    expect(company.websiteUrl).toBe("http://speak.com");
    expect(company.market).toContain("Education");
  });

  it("parse_failed si no hay JSON-LD de tipo JobPosting", () => {
    const result = parseJobDetail("<html><body>nada acá</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("parse_failed");
    }
  });
});
