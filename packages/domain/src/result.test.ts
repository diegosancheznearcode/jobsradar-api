import { describe, expect, it } from "vitest";
import { err, ok } from "./result.js";
import type { ExtractionError, Result } from "./result.js";

describe("Result constructors", () => {
  it("ok() produce { ok: true, value }", () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("err() produce { ok: false, error }", () => {
    const error: ExtractionError = { kind: "not_found", retryable: false };
    const result = err(error);
    expect(result).toEqual({ ok: false, error });
  });

  it("permite narrowing por result.ok", () => {
    const result: Result<number, ExtractionError> = ok(7);
    if (result.ok) {
      expect(result.value).toBe(7);
    } else {
      throw new Error("no debería entrar acá");
    }
  });

  it("blocked y rate_limited son retryable: true; not_found y parse_failed no", () => {
    const blocked: ExtractionError = { kind: "blocked", retryable: true, detail: "captcha" };
    const rateLimited: ExtractionError = { kind: "rate_limited", retryable: true, retryAfterMs: 5000 };
    const notFound: ExtractionError = { kind: "not_found", retryable: false };
    const parseFailed: ExtractionError = {
      kind: "parse_failed",
      retryable: false,
      strategy: "json_ld",
      html: "<html></html>",
    };

    expect(blocked.retryable).toBe(true);
    expect(rateLimited.retryable).toBe(true);
    expect(notFound.retryable).toBe(false);
    expect(parseFailed.retryable).toBe(false);
  });
});
