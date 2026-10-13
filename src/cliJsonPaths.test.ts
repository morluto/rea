import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCliJsonPaths } from "./cliJsonInput.js";
import { electronActiveObservationInputSchema } from "./domain/javascript/electronActiveObservation.js";

const paths = [
  ["executable_path"],
  ["application_path"],
  ["application_root"],
] as const;

describe("CLI JSON path normalization", () => {
  it.each([
    ["executable_path", ""],
    ["executable_path", " \t "],
    ["application_path", ""],
    ["application_path", " \t "],
    ["application_root", ""],
    ["application_root", " \t "],
  ])(
    "keeps blank %s (%j) invalid at the shared input boundary",
    (field, value) => {
      const input = {
        executable_path: "/synthetic/electron",
        application_path: "/synthetic/app",
        application_root: "/synthetic",
        [field]: value,
      };
      const parsed = electronActiveObservationInputSchema.safeParse(
        resolveCliJsonPaths(input, paths),
      );
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected blank path rejection");
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: [field] })]),
      );
      expect(input).toHaveProperty(field, value);
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
    const input = {
      executable_path: value,
      application_path: resolve("/synthetic/app"),
    };
    const normalized = resolveCliJsonPaths(input, paths);
    expect(normalized).toEqual(input);
    const parsed = electronActiveObservationInputSchema.safeParse(normalized);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected URL path rejection");
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({
        path: ["executable_path"],
        message: expect.stringContaining(
          "must be absolute local filesystem paths",
        ),
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
