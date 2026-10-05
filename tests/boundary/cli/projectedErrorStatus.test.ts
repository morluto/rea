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
    "keeps successful target-free inventory commands successful",
    async ({ cli }) => {
      const result = await cli.run({ arguments: ["capabilities", "--json"] });
      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();
    },
  );
});
