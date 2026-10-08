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
});
