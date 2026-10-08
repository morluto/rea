import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { firstProcedureAddress } from "../dist/application/RealHopperAssertions.js";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { resolveHopperAnalysisProfile } from "../dist/hopper/HopperAnalysisProfile.js";
import { HopperApplicationLauncher } from "../dist/hopper/BridgeLauncher.js";
import { HopperClient } from "../dist/hopper/HopperClient.js";
import { HOPPER_PROVIDER_IDENTITY } from "../dist/hopper/HopperProvider.js";
import { loadRealHopperFixtureTargets } from "./lib/real-hopper-fixture.mjs";

// These options belong to the native client, below the CLI/MCP tool surface.
assert.equal(
  process.platform,
  "darwin",
  "This lane requires native macOS Hopper",
);
const fixtures = await loadRealHopperFixtureTargets(
  process.env.REA_HOPPER_CONFORMANCE_MANIFEST_PATH ??
    "build/conformance/manifest.json",
);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "rea-hopper-deadlines-")),
);
const target = join(root, "deadline-fixture");
let client;
try {
  await copyFile(fixtures.primary.path, target);
  const parsed = await parseBinaryTarget(target);
  if (!parsed.ok) throw parsed.error;
  const launcherPath =
    process.env.HOPPER_LAUNCHER_PATH ??
    "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
  const resolved = await resolveHopperAnalysisProfile(parsed.value, {
    launcherPath,
    loaderArgsOverride: [],
    provider: HOPPER_PROVIDER_IDENTITY,
  });
  if (!resolved.ok) throw resolved.error;
  const image = resolved.value.profile?.parameters.prepared_image;
  client = new HopperClient({
    launcher: new HopperApplicationLauncher({
      launcherPath,
      targetPath: target,
      targetKind: "executable",
      launchMode: "native",
      loaderArgs: resolved.value.compatibility.loaderArgs,
      ...(image === undefined
        ? {}
        : {
            preparedImage: { image, sourceSha256: parsed.value.sha256 },
          }),
      bridgeScriptPath: fileURLToPath(
        new URL("../bridge/hopper_bridge.py", import.meta.url),
      ),
    }),
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool(name, args);
    if (!result.ok) throw result.error;
    return result.value;
  };
  const procedures = await call("list_procedures");
  const address = firstProcedureAddress(procedures);
  const original = await call("comment", { address });
  for (const timeoutMs of [0, 10]) {
    const result = await client.callTool(
      "set_comment",
      { address, comment: "expired mutation must never reach Hopper" },
      {
        timeoutMs,
        ...(timeoutMs === 0
          ? {}
          : {
              progress: {
                report: () => {
                  const started = performance.now();
                  while (performance.now() - started < 30) {
                    // Delay the timer callback beyond the admitted deadline.
                  }
                  return Promise.resolve();
                },
              },
            }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "HopperTimeoutError");
    assert.equal(result.error.providerState, "not_started");
    assert.equal(await call("comment", { address }), original);
    assert.equal(client.requestActivity(), null);
  }
  const active = await client.callTool(
    "analyze_function",
    { procedure: address },
    { timeoutMs: 1 },
  );
  if (!active.ok) assert.equal(active.error._tag, "HopperTimeoutError");
  const activityAfterDeadline = client.requestActivity();
  await call("health");
  assert.equal(client.requestActivity(), null);
  const closed = await client.closeWithOutcome();
  if (!closed.ok) throw closed.error;
  console.log(
    JSON.stringify(
      {
        expiredNativeMutations: "not_applied",
        delayedProgress: "deadline_enforced",
        activeAnalysis: active.ok
          ? "completed_within_deadline"
          : "caller_timed_out",
        nativeWorkRetained: activityAfterDeadline !== null,
        lateReplyRecovery: "passed",
        cleanShutdown: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (client !== undefined) await client.close();
  await rm(root, { recursive: true, force: true });
}
