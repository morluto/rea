import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

const selectors = [
  ["function", "procedure", "analyze_function"],
  ["instructions", "procedure", "read_function_instructions"],
  ["decompile", "procedure", "procedure_pseudo_code"],
  ["xrefs", "address", "xrefs"],
  ["search", "pattern", "search_strings"],
  ["trace", "query", "trace_feature"],
] as const;

describe("CLI analysis selector boundaries", () => {
  cliTest(
    "rejects missing and conflicting selectors before opening a target",
    async ({ cli }) => {
      for (const [command, option, operation] of selectors) {
        for (const [selection, reason] of [
          [[], "missing_argument"],
          [["first", `--${option}=-second`], "invalid_value"],
        ] as const) {
          const result = await cli.run({
            arguments: [
              command,
              "does-not-exist",
              ...selection,
              "--format",
              "json",
            ],
            environment: { REA_LOG_LEVEL: "silent" },
          });
          expect(result.exitCode).not.toBe(0);
          expect(result.json).toMatchObject({
            code: "invalid_request",
            details: { operation, issues: [{ path: [option], reason }] },
          });
        }
      }
    },
  );

  cliTest(
    "keeps named dash values out of global-option parsing",
    async ({ cli }) => {
      for (const [command, option] of selectors) {
        const result = await cli.run({
          arguments: [
            command,
            "does-not-exist",
            `--${option}=--help`,
            "--format",
            "json",
          ],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.json).toMatchObject({ code: "target_unavailable" });
      }
    },
  );
});
