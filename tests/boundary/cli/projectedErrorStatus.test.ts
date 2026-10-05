import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

describe("projected CLI failures", () => {
  cliTest(
    "exits unsuccessfully for invalid replay configuration",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: ["run-controlled-replay", "{}", "--json"],
        environment: { REA_JAVASCRIPT_REPLAY_NODE_PATH: "relative/node" },
      });
      expect(result.json).toMatchObject({
        code: "configuration_invalid",
        category: "execution_failure",
        retryable: false,
      });
      expect(result.exitCode).toBe(1);
    },
  );

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
