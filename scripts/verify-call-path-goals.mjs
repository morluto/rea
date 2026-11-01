import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { HOPPER_TARGET_LEASE_DIRECTORY } from "../dist/process/HopperLease.js";
import { snapshotHopperRuntime } from "./lib/real-hopper-cleanup.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";

const provider = process.argv[2];
assert.ok(
  provider === "ghidra" || provider === "hopper",
  "Usage: node scripts/verify-call-path-goals.mjs ghidra|hopper",
);
const run = createVerifierRun();
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "rea-call-path-goals-"));
const source = fileURLToPath(
  new URL("../tests/conformance/native/call-path-goals.c", import.meta.url),
);
const binary = join(
  root,
  process.platform === "darwin"
    ? "call-path-goals.dylib"
    : "call-path-goals.so",
);
const runtimeParent = process.platform === "darwin" ? "/tmp" : tmpdir();
const sessionsBefore = await snapshotHopperRuntime(
  runtimeParent,
  HOPPER_TARGET_LEASE_DIRECTORY,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/main.js", import.meta.url))],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, TMPDIR: root, REA_ANALYSIS_PROVIDER: provider },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({ name: "call-path-goals-verifier", version: "1" });
const ownedProcessIds = new Set();
let opened = false;
const call = async (name, args = {}) => {
  const started = performance.now();
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 180_000 },
  );
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      elapsed_ms: performance.now() - started,
      name,
      arguments: args,
      result,
    }),
  );
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
  return requireMcpOperationResult(result, name);
};
await withVerifierCleanup(
  async () => {
    await exec(process.env.REA_CC ?? "cc", [
      "-O0",
      "-g",
      "-fno-inline",
      // Keep internal calls direct on ELF; the fixture explicitly exports its entry points.
      "-fvisibility=hidden",
      ...(process.platform === "darwin"
        ? ["-dynamiclib"]
        : ["-shared", "-fPIC"]),
      source,
      "-o",
      binary,
    ]);
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        provider,
        node: process.version,
        host: `${process.platform}/${process.arch}`,
        binary,
        source_sha256: createHash("sha256")
          .update(await readFile(source))
          .digest("hex"),
        binary_sha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        run,
      }),
    );
    await client.connect(transport);
    assert.equal(typeof transport.pid, "number");
    ownedProcessIds.add(transport.pid);
    console.log(JSON.stringify({ mcp_pid: transport.pid }));
    await call("open_binary", { path: binary });
    opened = true;
    await call("binary_session");
    // Canonical addresses are obtained through the public provider identity read.
    const symbol = (name) =>
      `${process.platform === "darwin" ? "_" : ""}${name}`;
    const resolve = (name) =>
      call("procedure_address", { procedure: symbol(name) });
    const sink = await resolve("rea_path_sink");
    const first = await resolve("rea_path_first");
    const second = await resolve("rea_path_second");
    const reaches = await resolve("rea_path_export_reaches");
    const other = await resolve("rea_path_export_other");
    const indirect = await resolve("rea_path_indirect");
    await call("binary_session");
    for (const address of [sink, first, second, reaches, other, indirect])
      assert.equal(typeof address, "string");
    const trace = await call("trace_call_path", {
      start: sink,
      goals: [reaches, other, indirect],
      direction: "backward",
    });
    assert.deepEqual(trace.goal_results[0], {
      goal: reaches,
      goal_status: "reached",
      traversal_path: [sink, second, first, reaches],
    });
    for (const goal of trace.goal_results.slice(1)) {
      assert.equal(
        goal.goal_status,
        trace.truncated ? "unknown" : "not_reached",
      );
      assert.deepEqual(goal.traversal_path, []);
    }
    if (provider === "hopper") {
      assert.deepEqual(trace.roots, []);
      assert.equal(trace.truncated, true);
      for (const node of trace.nodes) {
        assert.equal(
          trace.relationship_coverage[node.address].status,
          "unknown",
        );
        assert.ok(
          trace.relationship_coverage[node.address].limited_directions.includes(
            "callers",
          ),
        );
      }
    } else {
      assert.deepEqual(trace.roots, [reaches]);
      assert.equal(trace.relationship_coverage[reaches].status, "complete");
    }
    assert.ok(
      trace.limitations.some((value) => value.includes("indirect calls")),
    );
    const single = await call("trace_call_path", {
      start: sink,
      goal: reaches,
      direction: "backward",
    });
    assert.equal(single.goal_status, "reached");
    assert.deepEqual(
      single.traversal_path,
      trace.goal_results[0].traversal_path,
    );
    const self = await call("trace_call_path", {
      start: other,
      goals: [other],
      direction: "backward",
    });
    assert.deepEqual(self.roots, provider === "hopper" ? [] : [other]);
    assert.equal(
      self.relationship_coverage[other].status,
      provider === "hopper" ? "unknown" : "complete",
    );
    assert.deepEqual(self.goal_results[0].traversal_path, [other]);
    const named = await call("trace_call_path", {
      start: symbol("rea_path_sink"),
      goals: [
        symbol("rea_path_export_reaches"),
        symbol("rea_path_export_other"),
      ],
      direction: "backward",
    });
    assert.deepEqual(named.goal_results, trace.goal_results.slice(0, 2));
    assert.deepEqual(named.roots, trace.roots);
    const forward = await call("trace_call_path", {
      start: reaches,
      goals: [sink, other],
      direction: "forward",
    });
    assert.deepEqual(forward.goal_results[0], {
      goal: sink,
      goal_status: "reached",
      traversal_path: [reaches, first, second, sink],
    });
    assert.equal(
      forward.goal_results[1].goal_status,
      forward.truncated ? "unknown" : "not_reached",
    );
    assert.deepEqual(forward.roots, []);
    console.log(JSON.stringify({ acceptance: "passed", provider }));
  },
  // Attempt independent cleanup after the operation, retaining all failures.
  // Collect evidence before removing the owned fixture.
  [
    async () => {
      if (opened) {
        await call("close_binary");
        const session = await call("binary_session");
        assert.equal(session.open, false);
      }
    },
    () => client.close(),
    () => transport.close(),
    async () => {
      const sessionsAfter = [
        ...(await snapshotHopperRuntime(
          runtimeParent,
          HOPPER_TARGET_LEASE_DIRECTORY,
          ownedProcessIds,
        )),
      ].filter((path) => !sessionsBefore.has(path));
      console.log(JSON.stringify({ sessionsAfter }));
      assert.deepEqual(sessionsAfter, []);
    },
    async () => {
      const privateSessionsAfter = [
        ...(await snapshotHopperRuntime(
          root,
          HOPPER_TARGET_LEASE_DIRECTORY,
          ownedProcessIds,
        )),
      ].filter((path) => !sessionsBefore.has(path));
      console.log(JSON.stringify({ privateSessionsAfter }));
      assert.deepEqual(privateSessionsAfter, []);
    },
    async () => {
      const cleanup = await completeVerifierRun(run);
      console.log(JSON.stringify({ cleanup }));
      assertVerifierCleanupComplete(cleanup.process_lineage);
    },
    async () => {
      await rm(root, { recursive: true, force: true });
      console.log(JSON.stringify({ fixture_removed: root }));
    },
  ],
);
