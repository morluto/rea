import { describe, expect, it } from "vitest";
import {
  compileInventoryPathGlob,
  inventoryPathGlobSchema,
} from "./inventoryPathGlob.js";

const matches = (glob: string, path: string) =>
  compileInventoryPathGlob(inventoryPathGlobSchema.parse(glob))(path);

describe("inventory path globs", () => {
  it.each([
    ["res/raw/a+b(1)[x].txt", "res/raw/a+b(1)[x].txt", true],
    ["res/raw/a+b(1)[x].txt", "res/raw/aab(1)x.txt", false],
    ["$^{}|\\.so", "$^{}|\\.so", true],
    ["*.so", "lib.so", true],
    ["*.so", "lib/x.so", false],
    ["*.SO", "lib.so", false],
    ["classes?.dex", "classes2.dex", true],
    ["classes?.dex", "classes.dex", false],
    ["**/x.so", "x.so", true],
    ["a/**/x.so", "a/x.so", true],
    ["a/**/x.so", "a/b/c/x.so", true],
    ["a/**", "a", false],
    ["a/**", "a/b/c", true],
    ["**", "a/b", true],
    ["**", "a", true],
    ["a/**/**/x.so", "a/x.so", true],
    ["*/**", "a", false],
    ["lib/*", "lib/x/y", false],
    ["é?.txt", "é\u{1F600}.txt", true],
  ])("%s against %s is %s", (glob, path, expected) => {
    expect(matches(glob, path)).toBe(expected);
  });

  // Repeated wildcards once backtracked polynomially in the name length.
  it("rejects repeated wildcard non-matches without backtracking", () => {
    const started = performance.now();
    expect(matches("*a*a*a*a*a*a*a*a*b", "a".repeat(20_000))).toBe(false);
    expect(
      matches("**/**/**/**/**/**/*a*a*a*b", Array(400).fill("aaaa").join("/")),
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it.each(["", "/abs", "a//b", "a/", "a**", "a/**b"])("refuses %j", (glob) => {
    expect(inventoryPathGlobSchema.safeParse(glob).success).toBe(false);
  });
});
