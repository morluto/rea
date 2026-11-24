import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { TARGET_FAILURE_CONTRACT } from "../support/targetFailure/contract.js";
import { loadTargetFailureReaders } from "../support/targetFailure/registry.js";

const fileIdentity = (path: string, bytes: Buffer) => ({
  kind: "file-snapshot-hash",
  path,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

// One generated suite for every registered reader: each case runs through
// the CLI and the MCP adapter, and both must report the kind's contract and
// the owner's facts.
for (const { operation, cases } of await loadTargetFailureReaders()) {
  const command = operation.replaceAll("_", "-");
  for (const testCase of cases) {
    cliTest(
      `${operation} refuses ${testCase.name} as ${testCase.kind} through CLI and MCP`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-target-failure-");
        const path = join(root, `${testCase.name}.bin`);
        const bytes = testCase.bytes();
        await writeFile(path, bytes);
        const expected = {
          ...TARGET_FAILURE_CONTRACT[testCase.kind],
          details: {
            operation,
            path,
            failure_kind: testCase.kind,
            ...(testCase.kind === "malformed" || testCase.kind === "truncated"
              ? { format_failure: testCase.kind }
              : {}),
            ...testCase.facts,
            ...(testCase.identity
              ? { partial_observation: fileIdentity(path, bytes) }
              : {}),
          },
        };

        const result = await cli.run({
          arguments: [command, path, ...(testCase.cli ?? []), "--json"],
        });
        expect(result.exitCode, result.stderr).toBe(1);
        expect(result.json).toMatchObject(expected);
        expect(result.json).not.toHaveProperty("recovery");
        expect(result.json).not.toHaveProperty("details.issues");

        const call = await cli.sharedMcpCall!();
        const { error } = parseMcpToolError(
          await call(operation, { path, ...testCase.mcp }),
        );
        expect(error).toMatchObject(expected);
        expect(error).not.toHaveProperty("recovery");
        // A refusal never alters the caller's selected file.
        expect((await readFile(path)).equals(bytes)).toBe(true);
      },
    );
  }
}
