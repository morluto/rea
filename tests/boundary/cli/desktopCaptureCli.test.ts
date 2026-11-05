import { expect, it } from "vitest";

import { serveCli as serve } from "./cliServeHarness.js";

it.each([
  [["--exclude", ""], "exclude"],
  [["--state-path", ""], "statePath"],
  [["--output", ""], "output"],
])(
  "refuses an empty path selection %j before it can name the current directory",
  async (option, field) => {
    const result = await serve([
      "capture-desktop-application",
      "--executable",
      "notes",
      "--output",
      "capture",
      ...option,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: expect.stringContaining(field) }),
      ],
    });
  },
);
