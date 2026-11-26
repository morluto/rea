import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

describe("projected CLI failures", () => {
  cliTest(
    "exits unsuccessfully for invalid managed reconstruction input",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: ["import-managed-reconstruction", "{}", "--json"],
      });
      expect(result.json).toMatchObject({ code: "invalid_request" });
      expect(result.exitCode).toBe(1);
    },
  );

  cliTest(
    "preserves failure identity when output selectors match or miss",
    async ({ cli }) => {
      for (const [format, filter] of [
        ["json", "missing"],
        ["json", "code"],
        ["toon", "message"],
        ["yaml", "message"],
        ["md", "message"],
      ] as const) {
        const result = await cli.run({
          arguments: [
            "import-managed-reconstruction",
            "{}",
            "--format",
            format,
            "--filter-output",
            filter,
          ],
        });
        expect(result.exitCode, `${format} ${filter}`).toBe(1);
        expect(result.stdout).toContain("invalid_request");
        expect(result.stdout).toContain("remediation");
        if (format === "json")
          expect(result.json).toMatchObject({ code: "invalid_request" });
      }
    },
  );
});
