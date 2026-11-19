import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCli } from "../../../src/cli.js";
import { closeCliResources } from "../../../src/cli/cliResources.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

it.each([
  {
    name: "guidance",
    args: ["guidance", "--query", "qzxv"],
    exitCode: 0,
  },
  {
    name: "MCP registration",
    args: [
      "mcp",
      "add",
      "--agent",
      "fixture-not-a-client",
      "--command",
      "fixture-mcp",
    ],
    exitCode: 1,
  },
])(
  "closes the resource scope acquired by $name",
  async ({ args, exitCode }) => {
    await closeCliResources();
    const home = await createTestTempDirectory("rea-cli-resource-close-");
    const cli = createCli(await registrationEnvironment(home));
    const runs = vi.spyOn(ArtifactResourceScope.prototype, "run");
    try {
      const result = await serveInProcessCli(cli, [...args, "--json"]);
      expect(result.exitCode, result.stdout).toBe(exitCode);
      const scope = runs.mock.contexts.find(
        (value): value is ArtifactResourceScope =>
          value instanceof ArtifactResourceScope,
      );
      if (scope === undefined)
        throw new Error("Expected command to enter its resource scope");
      await expect(scope.run(async () => "open")).resolves.toBe("open");
      await closeCliResources();
      await expect(scope.run(async () => "closed")).rejects.toMatchObject({
        reason: "unavailable",
      });
    } finally {
      runs.mockRestore();
      await closeCliResources();
    }
  },
);

cliTest.for([1, 2])(
  "waits for a healthy CLI owner and reports %i failed owners",
  async (failureCount, { processes }) => {
    // A child process owns the registry and the fixture file for its lifetime.
    const root = await createTestTempDirectory("rea-cli-mixed-close-");
    const resourceModule = new URL(
      "../../../dist/cli/cliResources.js",
      import.meta.url,
    ).href;
    const result = await processes.run(process.execPath, [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
       import { open } from "node:fs/promises";
       import { setImmediate } from "node:timers/promises";
       const { ownCliProcessResource, closeCliResources } = await import(process.argv[1]);
       const file = await open(process.argv[2], "wx");
       const failures = Array.from(
         { length: Number(process.argv[3]) },
         (_, index) => new Error("Retained resource " + (index + 1)),
       );
       for (const error of failures) {
         ownCliProcessResource(error.message, async () => { throw error; });
       }
       let release;
       const gate = new Promise((resolve) => { release = resolve; });
       ownCliProcessResource("healthy", async () => {
         await gate;
         await file.close();
       });
       const outcome = closeCliResources().then(
         () => ({ closed: true }),
         (error) => ({ closed: false, error }),
       );
       try {
         assert.equal(
           await Promise.race([outcome, setImmediate("pending")]),
           "pending",
           "shutdown settled while a healthy owner's file was still open",
         );
         release();
         const result = await outcome;
         assert.equal(result.closed, false);
         if (failures.length === 1) assert.equal(result.error, failures[0]);
         else {
           assert.ok(result.error instanceof AggregateError);
           assert.deepEqual(new Set(result.error.errors), new Set(failures));
         }
         assert.equal(file.fd, -1);
       } finally {
         release();
         await file.close();
       }`,
      resourceModule,
      join(root, "owned.txt"),
      String(failureCount),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
  },
);
