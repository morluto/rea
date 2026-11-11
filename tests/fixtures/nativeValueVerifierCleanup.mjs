import vm from "node:vm";
import * as fs from "node:fs/promises";
import * as util from "node:util";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
const path = new URL("../../scripts/lib/native-value-e2e.mjs", import.meta.url);
const source = await fs.readFile(path, "utf8");
const primary = new Error("inert connection failure");
const cleanup = new Error("inert client close failure");
const transportFailure = new Error("inert transport close failure");
const fault = process.argv[2];
const events = [];
let clientCloseCalls = 0;
let transportCloseCalls = 0;
let workspace;
const graph = {
  target_sha256: "a".repeat(64),
  seed: "0x1000",
  procedures: [],
  nodes: [
    {
      id: "c",
      evidence_id: "ev_" + "b".repeat(64),
      operation: { opcode: "CALL", inputs: [] },
    },
    {
      id: "p",
      evidence_id: "ev_" + "b".repeat(64),
      kind: "parameter",
      parameter: { ordinal: 0 },
    },
    {
      id: "r",
      evidence_id: "ev_" + "b".repeat(64),
      operation: { opcode: "RETURN", inputs: [{ location: "0x2000" }] },
    },
  ],
  edges: [
    {
      kind: "argument-binding",
      source: "c",
      target: "p",
      status: "derived",
      input_index: 1,
    },
    {
      kind: "parameter-use",
      source: "p",
      target: "r",
      status: "derived",
      input_index: 0,
    },
    {
      kind: "return-binding",
      source: "r",
      target: "c",
      status: "derived",
      input_index: 1,
    },
  ],
};
const evidence = {
  operation: "trace_native_values",
  provider: { id: "rea-workflow" },
  analysis_profile: {
    provider: { id: "rea-workflow" },
    parameters: {
      upstream_analysis_profile: {
        provider: { id: "ghidra" },
        digest: "c".repeat(64),
      },
    },
  },
  normalized_result: graph,
};
const execFile = () => {
  throw new Error("No child process authorized");
};
execFile[util.promisify.custom] = async () => {
  if (fault === "early") throw primary;
  return { stdout: JSON.stringify(evidence) };
};
class Client {
  async connect() {
    events.push("connect");
    throw primary;
  }
  async close() {
    events.push("client.close");
    clientCloseCalls++;
    if (["client", "both"].includes(fault) && clientCloseCalls === 1)
      throw cleanup;
  }
}
class Transport {
  async close() {
    events.push("transport.close");
    transportCloseCalls++;
    if (["transport", "both"].includes(fault) && transportCloseCalls === 1)
      throw transportFailure;
  }
}
const context = vm.createContext({
  process,
  Buffer,
  performance,
  console,
  URL,
  Error,
  AggregateError,
});
const module = new vm.SourceTextModule(source, {
  context,
  identifier: path.href,
  initializeImportMeta(meta) {
    meta.url = path.href;
  },
});
await module.link(async (specifier) => {
  let values;
  if (specifier === "node:child_process") values = { execFile };
  else if (specifier === "node:fs/promises")
    values = {
      ...fs,
      mkdtemp: async (...a) => (workspace = await fs.mkdtemp(...a)),
      rm: async (...a) => {
        events.push("rm");
        return fs.rm(...a);
      },
    };
  else if (specifier.startsWith("node:")) values = await import(specifier);
  else if (
    specifier.endsWith("/ArtifactResourceScope.js") ||
    specifier.endsWith("/AnalysisCleanupLease.js") ||
    specifier.endsWith("/verifier-cleanup.mjs")
  )
    values = await import(new URL(specifier, path));
  else if (specifier === "@modelcontextprotocol/client") values = { Client };
  else if (specifier === "@modelcontextprotocol/client/stdio")
    values = { StdioClientTransport: Transport };
  else if (specifier.endsWith("/evidence.js"))
    values = { parseEvidence: (v) => v };
  else if (specifier.endsWith("/analysisProfile.js"))
    values = { analysisProfileSchema: { parse: (v) => v } };
  else if (specifier.endsWith("/nativeValueTrace.js"))
    values = { nativeValueTraceSchema: { parse: (v) => v } };
  else if (specifier.endsWith("/mcp-verifier-results.mjs"))
    values = {
      requireMcpEvidenceBundle() {},
      requireMcpLifecycleResult() {},
      requireMcpOutput() {},
    };
  else if (specifier.endsWith("/real-ghidra-boundaries.mjs"))
    values = { verifyGhidraBoundaries() {} };
  else if (specifier.endsWith("/ghidra-value-scope-snapshot-e2e.mjs"))
    values = { verifyLegacyValueScopeSnapshot() {} };
  else if (specifier.endsWith("/real-ghidra-project-identity.mjs"))
    values = { verifyGhidraProjectIdentity() {} };
  else if (specifier.endsWith("/real-ghidra-socket-boundary.mjs"))
    values = { verifyGhidraSocketBoundary() {} };
  else throw new Error("Unexpected import " + specifier);
  return new vm.SyntheticModule(
    Object.keys(values),
    function () {
      for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    },
    { context },
  );
});
await module.evaluate();
let failure;
try {
  await module.namespace.verifyNativeValueE2e(
    { path: "/inert/not-opened", sha256: "a".repeat(64) },
    "0x1000",
    "0x2000",
  );
} catch (cause) {
  failure = cause;
}
const allFailures = (failure) => [
  failure,
  ...(failure?.errors ?? []).flatMap(allFailures),
  ...(failure?.cause === undefined ? [] : allFailures(failure.cause)),
];
try {
  const present = await fs.stat(workspace).then(
    () => true,
    () => false,
  );
  const failures = allFailures(failure);
  assert.ok(
    failures.includes(primary),
    "Original verification failure was lost",
  );
  if (fault === "early") {
    assert.deepEqual(events, ["rm"]);
    assert.equal(present, false);
  } else {
    assert.deepEqual(events, [
      "connect",
      "client.close",
      "transport.close",
      ...(fault === "none" ? ["rm"] : []),
    ]);
    const failed = ["client", "transport", "both"].includes(fault);
    assert.equal(present, failed);
    if (failed) {
      if (["client", "both"].includes(fault))
        assert.ok(failures.includes(cleanup));
      if (["transport", "both"].includes(fault))
        assert.ok(failures.includes(transportFailure));
      assert.equal(failure.retained_workspace, workspace);
      const leases = new Set(failures.flatMap((f) => f?.cleanupLeases ?? []));
      assert.equal(
        leases.size,
        fault === "both" ? 2 : 1,
        "Exactly the failed owners remain retryable",
      );
      for (const lease of leases) await lease.release();
      assert.equal(
        clientCloseCalls,
        ["client", "both"].includes(fault) ? 2 : 1,
      );
      assert.equal(
        transportCloseCalls,
        ["transport", "both"].includes(fault) ? 2 : 1,
      );
    }
  }
  console.log(
    JSON.stringify({
      fault,
      primaryPreserved: true,
      retiredWorkspace: !present,
      exactRetry: ["client", "transport", "both"].includes(fault),
    }),
  );
} finally {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
}
