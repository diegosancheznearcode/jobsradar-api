import { describe, expect, it } from "vitest";
import { matchesMaxCompanySize } from "./companySizeFilter.js";

describe("matchesMaxCompanySize", () => {
  it("sin maxCompanySize, siempre matchea (comportamiento original)", () => {
    expect(matchesMaxCompanySize("501-1000 Employees", undefined)).toBe(true);
    expect(matchesMaxCompanySize(null, undefined)).toBe(true);
  });

  it("un rango cuyo tope superior está dentro del máximo, matchea", () => {
    expect(matchesMaxCompanySize("11-50 Employees", 50)).toBe(true);
    expect(matchesMaxCompanySize("1-10 Employees", 50)).toBe(true);
  });

  it("un rango cuyo tope superior excede el máximo, no matchea", () => {
    expect(matchesMaxCompanySize("51-200 Employees", 50)).toBe(false);
  });

  it("un rango abierto ('X+ Employees') nunca matchea un tope máximo", () => {
    expect(matchesMaxCompanySize("5000+ Employees", 50)).toBe(false);
  });

  it("size null no matchea si hay un maxCompanySize activo", () => {
    expect(matchesMaxCompanySize(null, 50)).toBe(false);
  });

  it("un formato inesperado no matchea (no arriesga falso positivo)", () => {
    expect(matchesMaxCompanySize("algo raro", 50)).toBe(false);
  });
});
