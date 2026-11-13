import { isAbsolute, win32 } from "node:path";

import { expect, it } from "vitest";
import { z } from "zod";

import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
  nulFreeStringSchema,
  windowsAbsolutePathPattern,
} from "./localPath.js";
import { projectInputIssues } from "./inputIssueProjection.js";

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

it("accepts and rejects exactly what the advertised-regex form did", () => {
  // The surrogate rule moved from `.regex()` to a check the schema does not
  // advertise, because publishing `^[^\uD800-\uDFFF]*$` made strict clients
  // refuse the whole tools request. The two forms must still agree on every
  // string this schema can see, including the boundaries on each side.
  const formerRule = nulFreeStringSchema
    .min(1)
    .regex(
      /^[^\uD800-\uDFFF]*$/u,
      "Local filesystem paths must contain well-formed Unicode",
    );

  const probes: string[] = [
    "",
    " ",
    "relative/path",
    "/absolute/path",
    "/tmp/😀",
    "/tmp/ spaced name ",
    "/tmp/\0nul",
    "/tmp/\x1f",
    "中文/路径",
    "\u{1D4B3}",
  ];
  // Every code unit on both sides of the surrogate block, so an off-by-one in
  // either form surfaces as a specific value rather than a generic failure.
  for (const codeUnit of [
    0xd7fe, 0xd7ff, 0xd800, 0xd801, 0xdbfe, 0xdc00, 0xdffe, 0xdfff, 0xe000,
    0xe001,
  ])
    probes.push(`/tmp/${String.fromCharCode(codeUnit)}`);
  // A well-formed pair is two surrogate code units and must still be admitted.
  probes.push(`/tmp/${String.fromCodePoint(0x1f600)}`);

  for (const probe of probes) {
    const former = formerRule.safeParse(probe);
    const current = localPathStringSchema.safeParse(probe);
    expect(current.success, JSON.stringify(probe)).toBe(former.success);
    if (former.success) continue;
    // Compare the caller-visible contract, not the raw Zod issue. `.regex()`
    // also carries `origin` and the source `pattern`; those are not part of
    // the projected correction, and `pattern` is the field this change exists
    // to keep out of published schemas.
    expect(
      projectInputIssues(current.error?.issues ?? [], probe),
      JSON.stringify(probe),
    ).toEqual(projectInputIssues(former.error?.issues ?? [], probe));
  }
});

it("advertises no surrogate range for a caller-selected path", () => {
  // The advertised schema is the thing strict clients compile. Keep the
  // runtime rule and the published schema explicitly separate so a future
  // change cannot reintroduce the pattern while the runtime check passes.
  const advertised = z.toJSONSchema(
    z.strictObject({ path: absoluteLocalPathStringSchema }),
    { io: "input" },
  );
  const serialized = JSON.stringify(advertised);
  expect(serialized).not.toMatch(/\\u[dD][89abAB]/u);
  expect(serialized).not.toMatch(/\\[ux]\{[dD][89abAB]/u);
  expect(serialized).toContain("\\\\x00");
});
