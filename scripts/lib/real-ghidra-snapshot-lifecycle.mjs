import {
  requireMcpToolError,
  requireMcpOperationResult,
} from "./mcp-verifier-results.mjs";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAnalysisSnapshot } from "#dist/domain/analysisSnapshot.js";
import { parseEvidenceBundle } from "#dist/domain/evidenceBundle.js";
import { toolContract } from "#dist/contracts/toolContracts.js";

/** @typedef {import("@modelcontextprotocol/client").Client} Client */
/** @typedef {import("./mcp-verifier-results.mjs").ToolName} ToolName */
/**
 * @template {ToolName} N
 * @typedef {import("./mcp-verifier-results.mjs").VerifierOperationResult<N>} VerifierOperationResult
 */
/**
 * The complete analyze_function dossier; a retained summary view has no
 * procedure.
 * @typedef {Extract<VerifierOperationResult<"analyze_function">, { readonly procedure: unknown }>} FunctionDossier
 */
/**
 * Call one tool and return its contract-validated operation result.
 * @typedef {<N extends ToolName>(name: N, args?: Record<string, unknown>) => Promise<VerifierOperationResult<N>>} CallTool
 */
/**
 * Require a snapshot binding rejection from one tool call.
 * @typedef {(name: ToolName, args: Record<string, unknown>) => Promise<void>} RejectSnapshot
 */

/**
 * Require the complete dossier that `detail: "complete"` selects.
 * @param {VerifierOperationResult<"analyze_function">} result
 * @returns {FunctionDossier}
 */
const completeDossier = (result) => {
  assert.ok(
    "procedure" in result,
    "analyze_function returned a summary view instead of its dossier",
  );
  return result;
};

// Bundle records keep each operation's normalized result as JSON; read it
// through that operation's own contract.
const annotationResult = toolContract("annotate_native_function").outputSchema
  .shape.normalized_result;
const nativeApiResult =
  toolContract("inspect_native_api").outputSchema.shape.normalized_result;

/**
 * Keep live Ghidra edits distinct from historical Evidence across snapshots.
 * @param {Client} client
 * @param {{ readonly path: string; readonly sha256: string }} target
 * @param {FunctionDossier} edited The MCP session's dossier after its edit.
 * @param {(command: "function", value: string, flags?: readonly string[]) => Promise<FunctionDossier>} cli
 *   Runs a one-shot CLI command against its own unmodified database.
 */
export async function verifyGhidraSnapshotLifecycle(
  client,
  target,
  edited,
  cli,
) {
  const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-snapshot-proof-"));
  let successfulCalls = 0;
  let rejectedCalls = 0;
  /** @type {CallTool} */
  const call = async (name, args = {}) => {
    const result = requireMcpOperationResult(
      await client.callTool({ name, arguments: args }, { timeout: 180000 }),
      name,
    );
    successfulCalls++;
    return result;
  };
  /** @type {RejectSnapshot} */
  const rejectSnapshot = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.equal(
      reply.isError,
      true,
      `${name} accepted a mutated snapshot binding`,
    );
    const error = requireMcpToolError(reply);
    assert.equal(
      error.code,
      "evidence_integrity_mismatch",
      JSON.stringify(reply),
    );
    assert.equal(error.retryable, false);
    rejectedCalls++;
  };
  const currentRunId = async () => {
    const { analysis_run: run } = await call("binary_session");
    assert.ok(run !== null, "binary_session omitted the open analysis run");
    return run.run_id;
  };
  try {
    const entry = edited.procedure.address;
    const snapshotPath = join(workspace, "original.json");
    // The CLI has its own unmodified database and writes the production snapshot format.
    const original = await cli("function", entry, ["--snapshot", snapshotPath]);
    const snapshotBytes = await readFile(snapshotPath);
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(snapshotBytes.toString("utf8")),
    );
    assert.equal(snapshot.target.identity.sha256, target.sha256);
    assert.notEqual(original.procedure.name, edited.procedure.name);
    const runId = await currentRunId();
    const api = await call("inspect_native_api", { procedure: entry });
    assert.equal(api.procedure.name, edited.procedure.name);
    for (const repeatedOpen of [false, true]) {
      if (repeatedOpen)
        await call("open_binary", { path: target.path, provider_id: "ghidra" });
      const destination = join(
        workspace,
        repeatedOpen ? "repeated.json" : "edited.json",
      );
      await rejectSnapshot("close_binary", { snapshot_path: destination });
      await assert.rejects(access(destination), { code: "ENOENT" });
      assert.equal(await currentRunId(), runId);
      assert.deepEqual(
        await call("analyze_function", {
          procedure: entry,
          detail: "complete",
        }),
        edited,
      );
    }
    await rejectSnapshot("open_binary", {
      path: target.path,
      provider_id: "ghidra",
      snapshot_path: snapshotPath,
    });
    assert.deepEqual(await readFile(snapshotPath), snapshotBytes);
    assert.equal(await currentRunId(), runId);
    assert.deepEqual(
      await call("analyze_function", { procedure: entry, detail: "complete" }),
      edited,
    );

    // Mutable results remain exportable as observations, with their mutation Evidence.
    const bundlePath = join(workspace, "observations.json");
    await call("export_evidence_bundle", { path: bundlePath });
    const bundle = parseEvidenceBundle(
      JSON.parse(await readFile(bundlePath, "utf8")),
    );
    const annotation = bundle.records.find((record) => {
      if (record.operation !== "annotate_native_function") return false;
      const { annotations } = annotationResult.parse(record.normalized_result);
      return (
        annotations.name === edited.procedure.name &&
        annotations.address === edited.procedure.address
      );
    });
    const editedApi = bundle.records.find((record) => {
      if (record.operation !== "inspect_native_api") return false;
      const { procedure } = nativeApiResult.parse(record.normalized_result);
      return (
        procedure.name === edited.procedure.name &&
        procedure.address === edited.procedure.address
      );
    });
    assert.ok(annotation);
    assert.ok(editedApi);

    await call("close_binary");
    await call("open_binary", {
      path: target.path,
      provider_id: "ghidra",
      snapshot_path: snapshotPath,
    });
    const restored = completeDossier(
      await call("analyze_function", { procedure: entry, detail: "complete" }),
    );
    assert.deepEqual(restored.procedure, original.procedure);
    assert.deepEqual(restored.comments, original.comments);
    assert.notEqual(await currentRunId(), runId);
    const freshPath = join(workspace, "fresh.json");
    await call("close_binary", { snapshot_path: freshPath });
    const fresh = parseAnalysisSnapshot(
      JSON.parse(await readFile(freshPath, "utf8")),
    );
    for (const historical of [annotation, editedApi])
      assert.deepEqual(
        fresh.evidence_bundle.records.find(
          (record) => record.evidence_id === historical.evidence_id,
        ),
        historical,
      );
    await call("open_binary", {
      path: target.path,
      provider_id: "ghidra",
      snapshot_path: freshPath,
    });
    await verifyConcurrentSnapshotClose({
      call,
      rejectSnapshot,
      workspace,
      target,
      entry,
      original,
    });
    return { successfulCalls, rejectedCalls };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   readonly call: CallTool;
 *   readonly rejectSnapshot: RejectSnapshot;
 *   readonly workspace: string;
 *   readonly target: { readonly path: string };
 *   readonly entry: string;
 *   readonly original: FunctionDossier;
 * }} context
 */
async function verifyConcurrentSnapshotClose({
  call,
  rejectSnapshot,
  workspace,
  target,
  entry,
  original,
}) {
  const destination = join(workspace, "concurrent.json");
  const annotation = call("annotate_native_function", {
    procedure: entry,
    name: "rea_concurrent_snapshot_edit",
    comment:
      "A successful edit must invalidate a concurrently requested snapshot.",
  });
  const close = rejectSnapshot("close_binary", { snapshot_path: destination });
  const [updated] = await Promise.all([annotation, close]);
  await assert.rejects(access(destination), { code: "ENOENT" });
  assert.equal((await call("binary_session")).open, true);
  assert.deepEqual(
    await call("analyze_function", { procedure: entry, detail: "complete" }),
    updated.dossier,
  );
  // Discard the ephemeral edit and leave the caller with a pristine database.
  await call("close_binary");
  await call("open_binary", { path: target.path, provider_id: "ghidra" });
  assert.deepEqual(
    completeDossier(
      await call("analyze_function", { procedure: entry, detail: "complete" }),
    ).procedure,
    original.procedure,
  );
}
