import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBinaryTarget } from "../../dist/application/BinaryTargetResolver.js";
import { createAnalysisProfile } from "../../dist/domain/analysisProfile.js";
import { serializeAnalysisSnapshot } from "../../dist/domain/analysisSnapshot.js";
import { createLegacyGhidraSnapshot } from "./ghidra-legacy-snapshot-e2e.mjs";
import {
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./mcp-verifier-results.mjs";

/** A dossier from an earlier bridge must not be replayed into a newly qualified trace. */
export async function verifyLegacyValueScopeSnapshot(
  client,
  { target, procedure, observed, env },
) {
  const { producer } = observed.analysis_profile.parameters;
  const legacyProfile = createAnalysisProfile(observed.provider, {
    ...observed.analysis_profile.parameters,
    producer: { ...producer, sources_sha256: "0".repeat(64) },
  });
  const parsed = await parseBinaryTarget(target.path, {
    cwd: process.cwd(),
    hostArchitecture: process.arch,
  });
  if (!parsed.ok) throw parsed.error;
  const nativeTarget = parsed.value;
  const result = structuredClone(observed.normalized_result);
  const flow = result.native_value_flow;
  assert.equal(flow.available, true);
  const describesScope = (value) =>
    value.includes("LOAD and STORE") && value.includes("address varnodes");
  assert.ok(flow.limitations.some(describesScope));
  flow.limitations = flow.limitations.filter((value) => !describesScope(value));
  const snapshot = createLegacyGhidraSnapshot({
    nativeTarget,
    observed,
    result,
    legacyProfile,
  });
  const path = join(env.TMPDIR, `legacy-value-scope-${randomUUID()}.json`);
  await writeFile(path, serializeAnalysisSnapshot(snapshot), { flag: "wx" });
  try {
    const bytes = await readFile(path);
    const session = requireMcpLifecycleResult(
      await client.callTool({ name: "binary_session", arguments: {} }),
      "binary_session",
    );
    const reply = await client.callTool({
      name: "open_binary",
      arguments: {
        path: target.path,
        provider_id: "ghidra",
        snapshot_path: path,
      },
    });
    assert.equal(reply.isError, true);
    assert.match(producer.sources_sha256, /^[0-9a-f]{64}$/u);
    const error = requireMcpToolError(reply);
    assert.equal(error.code, "evidence_integrity_mismatch");
    assert.deepEqual(error.details.binding_mismatch.profile_digest, {
      snapshot: legacyProfile.digest,
      selected: observed.analysis_profile.digest,
    });
    assert.deepEqual(
      requireMcpLifecycleResult(
        await client.callTool({ name: "binary_session", arguments: {} }),
        "binary_session",
      ),
      session,
    );
    const fresh = await client.callTool(
      { name: "trace_native_values", arguments: { procedure, max_depth: 0 } },
      { timeout: 180000 },
    );
    assert.notEqual(fresh.isError, true, JSON.stringify(fresh));
    const trace = requireMcpOutput(fresh, "trace_native_values");
    assert.ok(trace.normalized_result.limitations.some(describesScope));
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await rm(path);
  }
}
