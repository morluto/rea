import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { ghidraSessionRoot } from "./GhidraSessionRoot.js";

const hasDotPrefixElement = (directory: string): boolean =>
  directory.split(sep).some((element) => element.startsWith("."));

const POSIX = process.platform !== "win32";
const posixFallback = join(resolve(sep), "tmp");
const posixBase = (...segments: string[]) => join(resolve(sep), ...segments);

describe("ghidraSessionRoot", () => {
  it("keeps an inherited base that Ghidra accepts", () => {
    const base = posixBase("var", "tmp", "rea-run");
    expect(ghidraSessionRoot({ base, fallback: posixFallback })).toBe(base);
  });

  it("keeps a base whose elements only contain an interior dot", () => {
    const base = posixBase("opt", "rea.run", "session");
    expect(ghidraSessionRoot({ base, fallback: posixFallback })).toBe(base);
  });

  it("relocates a dot-prefixed base to the supplied dot-free fallback", () => {
    const base = posixBase("home", "operator", ".cache", "scratch");
    expect(ghidraSessionRoot({ base, fallback: posixFallback })).toBe(
      posixFallback,
    );
  });

  it("relocates a base that is itself a hidden directory", () => {
    const base = posixBase("home", "operator", ".tmp");
    expect(ghidraSessionRoot({ base, fallback: posixBase("var", "tmp") })).toBe(
      posixBase("var", "tmp"),
    );
  });

  it("ignores a fallback that is itself dotted", () => {
    const base = posixBase("home", "operator", ".cache", "scratch");
    expect(
      ghidraSessionRoot({
        base,
        fallback: posixBase("home", "operator", ".tmp"),
      }),
    ).toBe(posixBase("home", "operator"));
  });

  it("never returns a path with a dot-prefixed element", () => {
    const directory = ghidraSessionRoot({
      base: posixBase("home", "operator", ".cache", "scratch"),
      fallback: posixBase("home", "operator", ".cache"),
    });
    expect(hasDotPrefixElement(directory)).toBe(false);
  });

  it("uses the nearest safe ancestor when the platform has no fallback", () => {
    expect(
      ghidraSessionRoot({
        base: posixBase("Users", "operator", ".cache", "scratch"),
        platform: "win32",
      }),
    ).toBe(posixBase("Users", "operator"));
  });

  it.skipIf(!POSIX)("prefers the platform temp directory by default", () => {
    expect(
      ghidraSessionRoot({ base: posixBase("home", "operator", ".cache") }),
    ).toBe(posixBase("tmp"));
  });
});
