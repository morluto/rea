import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cliJsonCallerPathSchema,
  resolveCliJsonPaths,
} from "./cli/cliJsonInput.js";
import { electronActiveObservationInputSchema } from "./domain/javascript/electronActiveObservation.js";

const paths = [
  ["executable_path"],
  ["application_path"],
  ["application_root"],
] as const;

describe("CLI JSON path normalization", () => {
  it.each([" ", "\t\r\n", "\u00a0", "\u2003", "\ufeff"])(
    "refuses blank caller path %j before normalization",
    (path) => {
      expect(cliJsonCallerPathSchema.safeParse(path).success).toBe(false);
      expect(resolveCliJsonPaths({ executable_path: path }, paths)).toEqual({
        executable_path: path,
      });
    },
  );
  it.each(["", " \t "])(
    "keeps blank Electron paths %j invalid after normalization",
    (value) => {
      const input = Object.freeze({
        executable_path: value,
        application_path: value,
        application_root: value,
      });
      const normalized = resolveCliJsonPaths(input, paths);
      expect(normalized).toEqual(input);
      const parsed = electronActiveObservationInputSchema.safeParse(normalized);
      if (parsed.success) throw new Error("Expected blank path rejection");
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining(
          paths.map((path) => expect.objectContaining({ path })),
        ),
      );
    },
  );

  it("resolves selected relative paths without trimming names or changing unrelated fields", () => {
    const input = {
      browser: { executable_path: " browser ", label: "relative-label" },
      application_path: "app",
    };
    expect(
      resolveCliJsonPaths(input, [["browser", "executable_path"]]),
    ).toEqual({
      browser: {
        executable_path: resolve(" browser "),
        label: "relative-label",
      },
      application_path: "app",
    });
    expect(input.browser.executable_path).toBe(" browser ");
  });

  it.each([
    "file:///opt/electron",
    "FILE:electron",
    "https://example.test/app",
  ])("keeps URL %j distinguishable from a local path", (value) => {
    const expected = {
      executable_path: value,
      application_path: resolve("/synthetic/app"),
    };
    const input = { ...expected };
    const normalized = resolveCliJsonPaths(input, paths);
    expect(normalized).toEqual(expected);
    expect(input).toEqual(expected);
    const parsed = electronActiveObservationInputSchema.safeParse(normalized);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected URL path rejection");
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({
        path: ["executable_path"],
        code: "invalid_format",
        format: "regex",
      }),
    ]);
  });

  it.each([
    "bin/electron",
    "release:v1/electron",
    "C:\\Electron\\electron.exe",
  ])("keeps resolving local path %j", (value) => {
    expect(resolveCliJsonPaths({ executable_path: value }, paths)).toEqual({
      executable_path: resolve(value),
    });
  });
});
