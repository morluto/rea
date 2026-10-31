import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  "analysis",
  "close_binary",
  "session-check",
  "client",
  "transport",
  "snapshot",
  "lineage",
  "remove",
])("finalizes the call-path verifier after %s failure", async (stage) => {
  const root = await createTestTempDirectory("rea-call-path-verifier-test-");
  const preload = join(root, "controls.mjs");
  const events = join(root, "events.jsonl");
  await writeFile(
    preload,
    String.raw`
      import { appendFileSync, writeFileSync } from "node:fs";
      import * as fs from "node:fs/promises";
      import { registerHooks } from "node:module";
      const stage = process.env.REA_TEST_STAGE;
      const record = (event) => appendFileSync(process.env.REA_TEST_EVENTS, JSON.stringify(event) + "\n");
      const fail = (name) => { if (stage === name) throw new Error("controlled " + name + " failure"); };
      let snapshotCalls = 0;
      let closed = false;
      const controls = {
        execFile(_command, args, callback) {
          writeFileSync(args.at(-1), "inert compiler output");
          callback(null, "", "");
        },
        mkdtemp: fs.mkdtemp,
        readFile: fs.readFile,
        async rm(path, options) {
          record("remove");
          fail("remove");
          await fs.rm(path, options);
        },
        Client: class {
          async connect() {}
          async callTool({ name }) {
            if (name === "open_binary") return {};
            if (name === "binary_session") return { open: !closed || stage === "session-check" };
            if (name === "close_binary") {
              record("close_binary"); closed = true; fail("close_binary"); return {};
            }
            // Stop after opening a session, before any real provider work.
            throw new Error("controlled analysis failure");
          }
          async close() { record("client"); fail("client"); }
        },
        StdioClientTransport: class {
          pid = process.pid;
          async close() { record("transport"); fail("transport"); }
        },
        requireMcpOperationResult: (value) => value,
        HOPPER_TARGET_LEASE_DIRECTORY: "controlled-leases",
        async snapshotHopperRuntime() {
          snapshotCalls++;
          if (snapshotCalls > 1) { record("snapshot"); fail("snapshot"); }
          return new Set();
        },
        createVerifierRun: () => ({ run_id: "controlled" }),
        async completeVerifierRun() { record("lineage"); return { process_lineage: {} }; },
        assertVerifierCleanupComplete() { fail("lineage"); },
      };
      globalThis.callPathVerifierControls = controls;
      const modules = new Map([
        ["node:child_process", ["execFile"]],
        ["node:fs/promises", ["mkdtemp", "readFile", "rm"]],
        ["@modelcontextprotocol/client", ["Client"]],
        ["@modelcontextprotocol/client/stdio", ["StdioClientTransport"]],
        ["./lib/mcp-verifier-results.mjs", ["requireMcpOperationResult"]],
        ["../dist/process/HopperLease.js", ["HOPPER_TARGET_LEASE_DIRECTORY"]],
        ["./lib/real-hopper-cleanup.mjs", ["snapshotHopperRuntime"]],
        ["./lib/verifier-run.mjs", ["createVerifierRun", "completeVerifierRun", "assertVerifierCleanupComplete"]],
      ]);
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const names = modules.get(specifier);
          if (!names) return nextResolve(specifier, context);
          const source = names.map(name => "export const " + name + " = globalThis.callPathVerifierControls." + name + ";").join("\n");
          return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
        },
      });
    `,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      fileURLToPath(
        new URL("../../../scripts/verify-call-path-goals.mjs", import.meta.url),
      ),
      "ghidra",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        REA_TEST_STAGE: stage,
        REA_TEST_EVENTS: events,
      },
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(result.stderr).toContain("controlled analysis failure");
  const attempted = (await readFile(events, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string);
  expect(attempted).toEqual([
    "close_binary",
    "client",
    "transport",
    "snapshot",
    "snapshot",
    "lineage",
    "remove",
  ]);
  const retained = (await readdir(root)).filter((name) =>
    name.startsWith("rea-call-path-goals-"),
  );
  expect(retained).toHaveLength(stage === "remove" ? 1 : 0);
  if (stage === "remove")
    expect(result.stdout).not.toContain('"fixture_removed"');
  if (!["analysis", "session-check"].includes(stage))
    expect(result.stderr).toContain(`controlled ${stage} failure`);
  if (stage === "session-check")
    expect(result.stderr).toContain("AssertionError");
});
