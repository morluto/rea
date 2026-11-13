import { isAbsolute, win32 } from "node:path";

import { expect, it } from "vitest";
import { z } from "zod";

import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
  windowsAbsolutePathPattern,
} from "./localPath.js";

const PATHS = [
  "/absolute/path",
  "/",
  "relative/path",
  "C:\\absolute\\path",
  "c:/absolute/path",
  "C:relative/path",
  "\\\\server\\share\\path",
  "\\rooted\\path",
  "//server/share/path",
  "file:///absolute/path",
];

it("matches the host path module for absolute local paths", () => {
  const checked: string[] = [];
  for (const path of PATHS) {
    checked.push(path);
    expect(absoluteLocalPathStringSchema.safeParse(path).success).toBe(
      isAbsolute(path),
    );
  }
  expect(checked).toEqual(
    expect.arrayContaining([
      "/absolute/path",
      "relative/path",
      "file:///absolute/path",
    ]),
  );
  expect(absoluteLocalPathStringSchema.safeParse("").success).toBe(false);
  expect(
    absoluteLocalPathStringSchema.safeParse("/absolute/with\0nul").success,
  ).toBe(false);
});

it("keeps the Windows absolute-path pattern valid in every client mode", () => {
  // Annex B and `u` accept an unescaped `/` inside a class; `v` does not, and a
  // client that compiles advertised patterns rejects the complete tools request.
  for (const flags of ["", "u", "v"])
    expect(
      () => new RegExp(windowsAbsolutePathPattern.source, flags),
      flags,
    ).not.toThrow();
  const checked: string[] = [];
  for (const path of PATHS) {
    checked.push(path);
    expect(windowsAbsolutePathPattern.test(path), path).toBe(
      win32.isAbsolute(path),
    );
  }
  expect(checked).toEqual(
    expect.arrayContaining([
      "C:\\absolute\\path",
      "C:relative/path",
      "/absolute/path",
    ]),
  );
});

it("emits no surrogate-range pattern in advertised JSON Schema", () => {
  // #10348: a `pattern` containing `\uD800-\uDFFF` cannot compile in
  // scalar-Unicode regex engines, so strict validators reject the whole
  // tool request. The surrogate check is a `.refine(...)` now, which
  // validates at parse time without emitting a pattern.
  for (const schema of [localPathStringSchema, absoluteLocalPathStringSchema]) {
    const advertised = JSON.stringify(z.toJSONSchema(schema, { io: "input" }));
    expect(advertised).not.toContain("\\uD800");
    expect(advertised).not.toContain("\\uDFFF");
  }
  expect(
    (
      z.toJSONSchema(localPathStringSchema, {
        io: "input",
      }) as { pattern?: string }
    ).pattern,
  ).toBe("^[^\\x00]*$");
});

it("rejects unpaired surrogates while preserving representable Unicode paths", () => {
  for (const path of ["/tmp/\ud800", "/tmp/\udc00", "/tmp/\ud800x"]) {
    expect(absoluteLocalPathStringSchema.safeParse(path).success, path).toBe(
      false,
    );
  }
  for (const path of ["/tmp/😀", "/tmp/�", "/tmp/ spaced name "]) {
    expect(absoluteLocalPathStringSchema.safeParse(path).success, path).toBe(
      true,
    );
  }
});
