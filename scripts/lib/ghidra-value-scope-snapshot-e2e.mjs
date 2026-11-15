import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBinaryTarget } from "../../dist/application/BinaryTargetResolver.js";
import { createAnalysisProfile } from "../../dist/domain/analysisProfile.js";
import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  serializeAnalysisSnapshot,
  snapshotBinding,
  snapshotTarget,
} from "../../dist/domain/analysisSnapshot.js";
import { createEvidence } from "../../dist/domain/evidence.js";
import { createEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import {
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./mcp-verifier-results.mjs";

/** A pre-scope dossier must not be replayed into a newly qualified trace. */
export async function verifyLegacyValueScopeSnapshot(
  client,
  { target, procedure, observed, env },
) {
  const { value_flow_effect_scope: scope, ...legacyParameters } =
    observed.analysis_profile.parameters;
  const legacyProfile = createAnalysisProfile(
    observed.provider,
    legacyParameters,
  );
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
  const evidence = createEvidence(nativeTarget, observed.provider, {
    operation: observed.operation,
    parameters: observed.parameters,
    result,
    rawResult: result,
    analysisProfile: legacyProfile,
    limitations: observed.limitations,
    locations: observed.locations,
  });
  const binding = snapshotBinding(legacyProfile);
  const identity = snapshotTarget(nativeTarget);
  const snapshot = parseAnalysisSnapshot({
    target: identity,
    binding,
    entries: [
      createAnalysisSnapshotEntry({
        target: identity,
        binding,
        operation: observed.operation,
        parameters: observed.parameters,
        execution: {
          result,
          rawResult: result,
          provider: observed.provider,
          analysisProfile: legacyProfile,
          limitations: observed.limitations,
          locations: observed.locations,
          subject: nativeTarget,
        },
      }),
    ],
    workflow_entries: [],
    evidence_bundle: createEvidenceBundle([evidence]),
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
    assert.equal(scope, "pcode-load-store-explicit-v1");
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
