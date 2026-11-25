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
for (const { operation, session, cases } of await loadTargetFailureReaders()) {
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
        expect(result.json).not.toHaveProperty("details.format_failure");
        // The CLI names operations by command, never by MCP tool name.
        expect(
          (result.json as { remediation: { action: string } }).remediation
            .action,
        ).not.toContain(operation);

        const call = await cli.sharedMcpCall!();
        if (session === true) {
          const opened = await call("open_binary", { path });
          expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
        }
        const response = await call(operation, {
          ...(session === true ? {} : { path }),
          ...testCase.mcp,
        });
        // A target failure is an isError tool result carrying the projected
        // diagnostic as JSON text, never a JSON-RPC error. The transport
        // removes the private structured carrier before sending errors.
        expect(response.isError).toBe(true);
        const { error } = parseMcpToolError(response);
        expect(error).toMatchObject(expected);
        expect(error).not.toHaveProperty("recovery");
        // A refusal never alters the caller's selected file.
        expect((await readFile(path)).equals(bytes)).toBe(true);
      },
    );
  }
}
