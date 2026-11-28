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

it("asks the registration host to exit once when a refused client cannot be rendered", async () => {
  await closeCliResources();
  const home = await createTestTempDirectory("rea-cli-registration-exit-");
  const cli = createCli(await registrationEnvironment(home));
  const exits: number[] = [];
  const output: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await cli.serve(
      [
        "mcp",
        "add",
        "--agent",
        "fixture-\uD800-client",
        "--command",
        "fixture-mcp",
        "--format",
        "md",
      ],
      {
        env: {},
        exit: (code) => {
          exits.push(code);
        },
        stdout: (text) => {
          output.push(text);
        },
      },
    );
    expect(exits).toEqual([1]);
    expect(output.join("")).toContain(
      "Markdown cannot preserve NUL or unpaired UTF-16 surrogates",
    );
    expect(output.join("")).toContain("Use --format json or --format yaml");
  } finally {
    process.exitCode = previousExitCode;
    await closeCliResources();
  }
});

cliTest(
  "keeps a later owner running when an earlier closer throws immediately",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-cli-sync-close-");
    const resourceModule = new URL(
      "../../../src/cli/cliResources.ts",
      import.meta.url,
    ).href;
    const result = await processes.run(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
       import { open } from "node:fs/promises";
       const { ownCliProcessResource, closeCliResources } = await import(process.argv[1]);
       const file = await open(process.argv[2], "wx");
       const syncError = new Error("synchronous closer");
       const order = [];
       ownCliProcessResource("sync", () => {
         order.push("sync");
         throw syncError;
       });
       let released = false;
       ownCliProcessResource("file", async () => {
         order.push("file");
         if (released) return;
         released = true;
         await file.close();
       });
       const outcome = await closeCliResources().then(
         () => ({ closed: true }),
         (error) => ({ closed: false, error }),
       );
       assert.equal(outcome.closed, false);
       assert.equal(outcome.error, syncError);
       assert.deepEqual(order, ["sync", "file"]);
       assert.equal(file.fd, -1);
       const retry = await closeCliResources().then(
         () => ({ closed: true }),
         (error) => ({ closed: false, error }),
       );
       assert.equal(retry.closed, false);
       assert.equal(retry.error, syncError);
       assert.deepEqual(order, ["sync", "file", "sync", "file"]);
       assert.equal(file.fd, -1);`,
      resourceModule,
      join(root, "owned.txt"),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
  },
);

cliTest.for([1, 2])(
  "waits for a healthy CLI owner and reports %i failed owners",
  async (failureCount, { processes }) => {
    // A child process owns the registry and the fixture file for its lifetime.
    const root = await createTestTempDirectory("rea-cli-mixed-close-");
    const resourceModule = new URL(
      "../../../src/cli/cliResources.ts",
      import.meta.url,
    ).href;
    const result = await processes.run(process.execPath, [
      "--experimental-strip-types",
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
