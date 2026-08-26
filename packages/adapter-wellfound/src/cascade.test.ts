import { describe, expect, it } from "vitest";
import { extractWithCascade, isCloudflareChallenge } from "./cascade.js";

describe("extractWithCascade", () => {
  it("devuelve el primer resultado no-null y su estrategia", () => {
    const result = extractWithCascade<{ found: boolean }>("<html></html>", [
      { strategy: "json_ld", extract: () => null },
      { strategy: "hydrated_state", extract: () => ({ found: true }) },
      { strategy: "css", extract: () => ({ found: false }) },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.strategy).toBe("hydrated_state");
      expect(result.value.data).toEqual({ found: true });
    }
  });

  it("prueba las estrategias en el orden dado (json_ld antes que hydrated_state)", () => {
    const order: string[] = [];
    extractWithCascade("<html></html>", [
      {
        strategy: "json_ld",
        extract: () => {
          order.push("json_ld");
          return "ganó json_ld";
        },
      },
      {
        strategy: "hydrated_state",
        extract: () => {
          order.push("hydrated_state");
          return "no debería ejecutarse";
        },
      },
    ]);

    expect(order).toEqual(["json_ld"]);
  });

  it("devuelve parse_failed con las estrategias intentadas si ninguna extrae nada", () => {
    const result = extractWithCascade("<html></html>", [
      { strategy: "json_ld", extract: () => null },
      { strategy: "hydrated_state", extract: () => null },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "parse_failed",
        retryable: false,
        strategy: "json_ld|hydrated_state",
        html: "<html></html>",
      });
    }
  });
});

describe("isCloudflareChallenge", () => {
  it("reconoce el título del challenge", () => {
    expect(isCloudflareChallenge("<title>Security Check | Wellfound</title>")).toBe(true);
  });

  it("no confunde una página normal con un challenge", () => {
    expect(isCloudflareChallenge("<title>VaulFi Careers</title>")).toBe(false);
  });
});
