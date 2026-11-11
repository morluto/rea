import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { registerHooks } from "node:module";

import { nativeCleanupState } from "./nativeVerifierCleanupMock.mjs";

const faults = new Set(["none", "client", "transport", "both", "early"]);
const fault = process.argv[2];
if (!faults.has(fault))
  throw new Error(`Unexpected native verifier cleanup fault: ${String(fault)}`);
nativeCleanupState.fault = fault;

const mockUrl = new URL("./nativeVerifierCleanupMock.mjs", import.meta.url)
  .href;
const redirected = new Set([
  "node:child_process",
  "node:fs/promises",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/client/stdio",
]);
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ? new URL(context.parentURL).pathname : "";
    if (!parent.endsWith("/scripts/lib/native-value-e2e.mjs"))
      return next(specifier, context);
    if (
      redirected.has(specifier) ||
      specifier.endsWith("/evidence.js") ||
      specifier.endsWith("/analysisProfile.js") ||
      specifier.endsWith("/nativeValueTrace.js") ||
      specifier.endsWith("/mcp-verifier-results.mjs") ||
      specifier.endsWith("/real-ghidra-boundaries.mjs") ||
      specifier.endsWith("/ghidra-value-scope-snapshot-e2e.mjs") ||
      specifier.endsWith("/real-ghidra-project-identity.mjs") ||
      specifier.endsWith("/real-ghidra-socket-boundary.mjs")
    )
      return { shortCircuit: true, url: mockUrl };
    return next(specifier, context);
  },
});

const { verifyNativeValueE2e } =
  await import("../../scripts/lib/native-value-e2e.mjs");
let failure;
try {
  await verifyNativeValueE2e(
    { path: "/inert/not-opened", sha256: "a".repeat(64) },
    "0x1000",
    "0x2000",
  );
} catch (cause) {
  failure = cause;
}
const allFailures = (error) => [
  error,
  ...(error?.errors ?? []).flatMap(allFailures),
  ...(error?.cause === undefined ? [] : allFailures(error.cause)),
];
const workspace = nativeCleanupState.workspace;
try {
  const present =
    workspace === undefined
      ? false
      : await fs.stat(workspace).then(
          () => true,
          () => false,
        );
  const failures = allFailures(failure);
  assert.ok(
    failures.includes(nativeCleanupState.primary),
    "Original verification failure was lost",
  );
  if (fault === "early") {
    assert.deepEqual(nativeCleanupState.events, ["rm"]);
    assert.equal(present, false);
  } else {
    assert.deepEqual(nativeCleanupState.events, [
      "connect",
      "client.close",
      "transport.close",
      ...(fault === "none" ? ["rm"] : []),
    ]);
    const failed = ["client", "transport", "both"].includes(fault);
    assert.equal(present, failed);
    if (failed) {
      if (["client", "both"].includes(fault))
        assert.ok(failures.includes(nativeCleanupState.cleanup));
      if (["transport", "both"].includes(fault))
        assert.ok(failures.includes(nativeCleanupState.transportFailure));
      assert.equal(failure.retained_workspace, workspace);
      const leases = new Set(
        failures.flatMap((item) => item?.cleanupLeases ?? []),
      );
      assert.equal(
        leases.size,
        fault === "both" ? 2 : 1,
        "Exactly the failed owners remain retryable",
      );
      for (const lease of leases) await lease.release();
      assert.equal(
        nativeCleanupState.clientCloseCalls,
        ["client", "both"].includes(fault) ? 2 : 1,
      );
      assert.equal(
        nativeCleanupState.transportCloseCalls,
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
  if (workspace !== undefined)
    await fs.rm(workspace, { recursive: true, force: true });
}
