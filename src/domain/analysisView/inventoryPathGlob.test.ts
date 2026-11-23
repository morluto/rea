import { describe, expect, it } from "vitest";
import {
  compileInventoryPathGlob,
  inventoryPathGlobSchema,
} from "./inventoryPathGlob.js";

const matches = (glob: string, path: string) =>
  compileInventoryPathGlob(inventoryPathGlobSchema.parse(glob)).test(path);

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
  ])("%s against %s is %s", (glob, path, expected) => {
    expect(matches(glob, path)).toBe(expected);
  });

  it.each(["", "/abs", "a//b", "a/", "a**", "a/**b"])("refuses %j", (glob) => {
    expect(inventoryPathGlobSchema.safeParse(glob).success).toBe(false);
  });
});
