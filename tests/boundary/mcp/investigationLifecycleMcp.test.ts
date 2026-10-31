import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import type { AnalysisClient } from "../../../src/application/AnalysisProvider.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { silentLogger } from "../../../src/logger.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpEvidenceBundle } from "../../fixtures/mcpEvidenceBundle.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Native behavior is simulated here. The real SDK, session, ledger, source
// parsers and atomic file owners provide the lifecycle boundaries under test.
const fixture = async (
  options: {
    readonly execute?: AnalysisClient["execute"];
    readonly close?: AnalysisClient["close"];
  } = {},
) => {
  const root = await createTestTempDirectory("rea-investigation-lifecycle-");
  const first = join(root, "first.hop");
  const second = join(root, "second.hop");
  await Promise.all([
    writeFile(first, "first fixture target"),
    writeFile(second, "second fixture target"),
  ]);
  const providerCalls: string[] = [];
  const base = createCacheProvider(providerCalls);
  const close = vi.fn<AnalysisClient["close"]>(
    options.close ?? (() => Promise.resolve(ok(null))),
  );
  const createClient = vi.fn<typeof base.createClient>((...arguments_) => ({
    ...base.createClient(...arguments_),
    ...(options.execute === undefined ? {} : { execute: options.execute }),
    close,
  }));
  const session = createTestBinarySession({ ...base, createClient });
  const harness = await createApplicationMcpHarness({
    session,
    serverOptions: { environment: {}, logger: silentLogger },
  });
  return {
    ...harness,
    root,
    first,
    second,
    providerCalls,
    createClient,
    providerClose: close,
  };
};

const call = async (
  client: Client,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<CallToolResult> => {
  const reply = await client.callTool({ name, arguments: arguments_ });
  expect(reply.isError, `${name}: ${JSON.stringify(reply.content)}`).not.toBe(
    true,
  );
  return reply;
};
const bundle = async (client: Client) =>
  parseMcpEvidenceBundle(await call(client, "get_evidence_bundle"));
const reference = (record: Evidence) => ({
  kind: "retained-evidence",
  evidence_id: record.evidence_id,
});
const pathSelection = {
  start: { address: "0x1000" },
  goal: { address: "0x1000" },
};
const query = { address: "0x1000", document: "fixture" };

const seedHistory = async (client: Client) => {
  const source = FUNCTION_COMPARISON_EXAMPLE.left;
  const path = parseEvidence(
    (
      await call(client, "build_call_path", {
        ...pathSelection,
        functions: [source],
      })
    ).structuredContent,
  );
  const summary = parseEvidence(
    (
      await call(client, "inspect_analysis_view", {
        source: reference(source),
        view: { kind: "summary" },
      })
    ).structuredContent,
  );
  const unknownFields = {
    severity: "medium",
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  };
  const unknown = z
    .object({ result: z.object({ unknown_id: z.string() }) })
    .parse(
      (
        await call(client, "record_unknown", {
          ...unknownFields,
          question: "Which source revision produced this fixture dossier?",
          domain: "provenance",
          supporting_evidence_ids: [source.evidence_id],
          contradicting_evidence_ids: [],
        })
      ).structuredContent,
    ).result;
  await call(client, "update_unknown", {
    ...unknownFields,
    unknown_id: unknown.unknown_id,
    expected_revision: 1,
    status: "investigating",
    supporting_evidence_ids: [source.evidence_id],
    contradicting_evidence_ids: [],
    resolution: null,
  });
  return { source, path, summary, unknown, before: await bundle(client) };
};

const cleared = (before: EvidenceBundle, retainedTarget: boolean) => ({
  cleared_evidence_records: before.records.length,
  cleared_unknown_revisions: before.unknowns.length,
  cleared_unknown_heads: new Set(
    before.unknowns.map(({ unknown_id }) => unknown_id),
  ).size,
  retained_target: retainedTarget,
});

it("closes and replaces the engine while retaining exact Evidence and Unknown history", async () => {
  const test = await fixture();
  await call(test.client, "open_binary", { path: test.first });
  await call(test.client, "address_name", query);
  const seeded = await seedHistory(test.client);
  expect(seeded.before.unknowns.map(({ revision }) => revision)).toEqual([
    1, 2,
  ]);
  await call(test.client, "close_binary");
  expect(test.providerClose).toHaveBeenCalledTimes(1);
  expect(
    (await call(test.client, "binary_session")).structuredContent,
  ).toMatchObject({ result: { open: false } });
  expect(await bundle(test.client)).toEqual(seeded.before);
  expect(
    parseEvidence(
      (
        await call(test.client, "build_call_path", {
          ...pathSelection,
          functions: [reference(seeded.source)],
        })
      ).structuredContent,
    ),
  ).toEqual(seeded.path);
  expect(
    parseEvidence(
      (
        await call(test.client, "inspect_analysis_view", {
          source: reference(seeded.source),
          view: { kind: "summary" },
        })
      ).structuredContent,
    ),
  ).toEqual(seeded.summary);
  expect(await bundle(test.client)).toEqual(seeded.before);

  await call(test.client, "open_binary", { path: test.second });
  await call(test.client, "address_name", query);
  expect(test.createClient).toHaveBeenCalledTimes(2);
  expect(
    test.providerCalls.filter((name) => name === "address_name"),
  ).toHaveLength(2);
  const after = await bundle(test.client);
  expect(after.unknowns).toEqual(seeded.before.unknowns);
  for (const record of seeded.before.records)
    expect(after.records).toContainEqual(record);
});

it("retains target-free history on close and clears it only through an explicit reset", async () => {
  const test = await fixture();
  const seeded = await seedHistory(test.client);
  await call(test.client, "close_binary");
  await call(test.client, "close_binary");
  expect(await bundle(test.client)).toEqual(seeded.before);
  expect(test.createClient).not.toHaveBeenCalled();
  const wrongRole = await test.client.callTool({
    name: "build_call_path",
    arguments: { ...pathSelection, functions: [reference(seeded.summary)] },
  });
  expect(parseMcpToolError(wrongRole)).toMatchObject({
    error: { code: "invalid_request" },
  });
  expect(await bundle(test.client)).toEqual(seeded.before);

  expect(
    (await call(test.client, "reset_investigation")).structuredContent,
  ).toEqual({ result: cleared(seeded.before, false) });
  expect(await bundle(test.client)).toEqual(createEvidenceBundle([]));
  expect(
    (await call(test.client, "list_unknowns")).structuredContent,
  ).toMatchObject({ result: { items: [] } });
  const missing = await test.client.callTool({
    name: "inspect_analysis_view",
    arguments: { source: reference(seeded.source), view: { kind: "summary" } },
  });
  expect(parseMcpToolError(missing)).toMatchObject({
    error: {
      code: "evidence_integrity_mismatch",
      details: { reason: "missing", evidence_id: seeded.source.evidence_id },
    },
  });
  const summaryOnly = createEvidenceBundle([seeded.summary]);
  const summaryPath = join(test.root, "summary-without-parent.json");
  await writeFile(summaryPath, JSON.stringify(summaryOnly));
  await call(test.client, "import_evidence_bundle", { path: summaryPath });
  const missingParent = await test.client.callTool({
    name: "inspect_analysis_view",
    arguments: { source: reference(seeded.source), view: { kind: "summary" } },
  });
  expect(parseMcpToolError(missingParent)).toMatchObject({
    error: {
      details: { reason: "missing", evidence_id: seeded.source.evidence_id },
    },
  });
  expect(await bundle(test.client)).toEqual(summaryOnly);
  expect(
    (await call(test.client, "reset_investigation")).structuredContent,
  ).toEqual({ result: cleared(summaryOnly, false) });
  expect(
    (await call(test.client, "reset_investigation")).structuredContent,
  ).toEqual({ result: cleared(createEvidenceBundle([]), false) });
  expect(test.createClient).not.toHaveBeenCalled();
});

it("resets records and replay bindings while keeping the same healthy engine", async () => {
  const test = await fixture();
  await call(test.client, "open_binary", { path: test.first });
  const original = parseEvidence(
    (await call(test.client, "address_name", query)).structuredContent,
  );
  const seeded = await seedHistory(test.client);
  expect(
    (await call(test.client, "reset_investigation")).structuredContent,
  ).toEqual({ result: cleared(seeded.before, true) });
  expect(test.providerClose).not.toHaveBeenCalled();
  expect(test.createClient).toHaveBeenCalledTimes(1);
  expect(await bundle(test.client)).toEqual(createEvidenceBundle([]));
  expect(
    (await call(test.client, "binary_session")).structuredContent,
  ).toMatchObject({ result: { open: true } });
  expect(
    parseEvidence(
      (await call(test.client, "address_name", query)).structuredContent,
    ),
  ).toEqual(original);
  expect(
    test.providerCalls.filter((name) => name === "address_name"),
  ).toHaveLength(2);
  expect((await bundle(test.client)).records).toEqual([original]);
});

it("preserves complete history when engine close fails and after its cleanup retry", async () => {
  let cleanupAllowed = false;
  const failure = new ProviderCleanupError(
    "fixture",
    ["fixture-owned-engine"],
    { reason: "Controlled engine cleanup refusal" },
  );
  const test = await fixture({
    close: () => Promise.resolve(cleanupAllowed ? ok(null) : err(failure)),
  });
  onTestFinished(() => {
    cleanupAllowed = true;
  });
  await call(test.client, "open_binary", { path: test.first });
  await call(test.client, "address_name", query);
  const seeded = await seedHistory(test.client);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const closed = await test.client.callTool({
      name: "close_binary",
      arguments: {},
    });
    expect(parseMcpToolError(closed)).toMatchObject({
      error: { code: "cleanup_incomplete" },
    });
    expect(await bundle(test.client)).toEqual(seeded.before);
  }
  cleanupAllowed = true;
  await call(test.client, "close_binary");
  expect(await bundle(test.client)).toEqual(seeded.before);
  expect(
    parseEvidence(
      (
        await call(test.client, "build_call_path", {
          ...pathSelection,
          functions: [reference(seeded.source)],
        })
      ).structuredContent,
    ),
  ).toEqual(seeded.path);
});

it("saves the complete history before clearing and restores it in a fresh public MCP process", async () => {
  const test = await fixture();
  const seeded = await seedHistory(test.client);
  const path = join(test.root, "complete investigation.json");
  await writeFile(path, "caller-owned destination");
  const refused = await test.client.callTool({
    name: "reset_investigation",
    arguments: { save_path: path },
  });
  expect(refused.isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("caller-owned destination");
  expect(await bundle(test.client)).toEqual(seeded.before);
  const reset = await call(test.client, "reset_investigation", {
    save_path: path,
    overwrite: true,
  });
  const saved = await readFile(path);
  expect(reset.structuredContent).toEqual({
    result: {
      ...cleared(seeded.before, false),
      saved_bundle: {
        path,
        bytes: saved.length,
        records: seeded.before.records.length,
        unknowns: seeded.before.unknowns.length,
      },
    },
  });
  expect(parseEvidenceBundle(JSON.parse(saved.toString("utf8")))).toEqual(
    seeded.before,
  );
  expect(await bundle(test.client)).toEqual(createEvidenceBundle([]));

  const fresh = await connectLocalToolsMcp();
  expect(
    (await fresh.call("import_evidence_bundle", { path })).isError,
  ).not.toBe(true);
  expect(
    parseMcpEvidenceBundle(await fresh.call("get_evidence_bundle", {})),
  ).toEqual(seeded.before);
  expect(
    parseEvidence(
      (
        await fresh.call("build_call_path", {
          ...pathSelection,
          functions: [reference(seeded.source)],
        })
      ).structuredContent,
    ),
  ).toEqual(seeded.path);
  expect(
    parseEvidence(
      (
        await fresh.call("inspect_analysis_view", {
          source: reference(seeded.source),
          view: { kind: "summary" },
        })
      ).structuredContent,
    ),
  ).toEqual(seeded.summary);
  expect((await readFile(path)).equals(saved)).toBe(true);
});

it("drains a late valid observation before saving and prevents it from entering the reset investigation", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let addressCalls = 0;
  const test = await fixture({
    execute: async (operation) => {
      if (operation === "health") return observed(null);
      addressCalls += 1;
      if (addressCalls === 1) {
        entered.resolve();
        await release.promise;
        return observed("late-before-reset");
      }
      return observed("fresh-after-reset");
    },
  });
  onTestFinished(() => release.resolve());
  await call(test.client, "open_binary", { path: test.first });
  const earlier = test.client.callTool({
    name: "address_name",
    arguments: query,
  });
  await entered.promise;
  const path = join(test.root, "drained.json");
  const resetting = test.client.callTool({
    name: "reset_investigation",
    arguments: { save_path: path },
  });
  await test.client.ping();
  const later = test.client.callTool({
    name: "address_name",
    arguments: query,
  });
  await test.client.ping();
  expect(addressCalls).toBe(1);
  release.resolve();
  const [, reset, next] = await Promise.all([earlier, resetting, later]);
  expect(reset.isError, JSON.stringify(reset)).not.toBe(true);
  expect(next.isError, JSON.stringify(next)).not.toBe(true);
  const saved = parseEvidenceBundle(JSON.parse(await readFile(path, "utf8")));
  expect(saved.records).toHaveLength(1);
  expect(saved.records[0]).toMatchObject({
    operation: "address_name",
    normalized_result: "late-before-reset",
  });
  expect(reset.structuredContent).toMatchObject({
    result: cleared(saved, true),
  });
  const current = await bundle(test.client);
  expect(current.records).toEqual([parseEvidence(next.structuredContent)]);
  expect(current.records[0]?.normalized_result).toBe("fresh-after-reset");
  expect(test.createClient).toHaveBeenCalledTimes(1);
  expect(test.providerClose).not.toHaveBeenCalled();
});

it("keeps history after a committed save fails final cleanup and permits its owner's retry", async () => {
  const test = await fixture();
  const seeded = await seedHistory(test.client);
  const path = join(test.root, "cleanup-retry.json");
  let cleanupAllowed = false;
  const original = OwnedStagedOutput.prototype.close;
  const seam = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      if (dirname(this.directory) === test.root && !cleanupAllowed) {
        await access(path); // The actual atomic publication already completed.
        throw new Error("Controlled staged-output cleanup refusal");
      }
      await original.call(this);
    });
  onTestFinished(() => {
    cleanupAllowed = true;
    seam.mockRestore();
  });
  const reset = await test.client.callTool({
    name: "reset_investigation",
    arguments: { save_path: path },
  });
  expect(parseMcpToolError(reset)).toMatchObject({
    error: { code: "cleanup_incomplete" },
  });
  expect(parseEvidenceBundle(JSON.parse(await readFile(path, "utf8")))).toEqual(
    seeded.before,
  );
  expect(await bundle(test.client)).toEqual(seeded.before);
  const stillBlocked = await test.client.callTool({
    name: "reset_investigation",
    arguments: {},
  });
  expect(parseMcpToolError(stillBlocked)).toMatchObject({
    error: { code: "cleanup_incomplete" },
  });
  expect(await bundle(test.client)).toEqual(seeded.before);
  cleanupAllowed = true;
  expect(
    (await call(test.client, "reset_investigation")).structuredContent,
  ).toEqual({ result: cleared(seeded.before, false) });
  expect(await bundle(test.client)).toEqual(createEvidenceBundle([]));
});

it("preserves the investigation when SDK cancellation arrives during final save cleanup", async () => {
  const test = await fixture();
  const seeded = await seedHistory(test.client);
  const path = join(test.root, "cancelled-reset.json");
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const original = OwnedStagedOutput.prototype.close;
  let held = false;
  const seam = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      await original.call(this);
      if (dirname(this.directory) === test.root && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    });
  onTestFinished(() => {
    release.resolve();
    seam.mockRestore();
  });
  const controller = new AbortController();
  const resetting = test.client
    .callTool(
      { name: "reset_investigation", arguments: { save_path: path } },
      { signal: controller.signal },
    )
    .then(
      (reply) => reply,
      (error: unknown) => error,
    );
  await entered.promise;
  controller.abort(
    new Error("Caller cancelled reset during final save cleanup"),
  );
  expect(await resetting).toMatchObject({
    message: expect.stringContaining("Caller cancelled reset"),
  });
  await test.client.ping();
  release.resolve();
  // A later admitted read joins server settlement even when SDK cancellation
  // suppresses the reset reply. The published file and all records must survive.
  expect(await bundle(test.client)).toEqual(seeded.before);
  expect(parseEvidenceBundle(JSON.parse(await readFile(path, "utf8")))).toEqual(
    seeded.before,
  );
  expect(
    (await call(test.client, "reset_investigation")).structuredContent,
  ).toEqual({ result: cleared(seeded.before, false) });
});

it("drains admitted work before retrying process cleanup and refuses reset while that owner is unresolved", async () => {
  const test = await fixture();
  const seeded = await seedHistory(test.client);
  const path = join(test.root, "process-cleanup-checkpoint.json");
  const originalBytes = Buffer.from("caller-owned checkpoint");
  await writeFile(path, originalBytes);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const events: string[] = [];
  let cleanupAllowed = false;
  const retainedProcessRoot = join(
    test.root,
    "simulated-retained-process-root",
  );
  const failure = new ProcessCaptureError(
    "Controlled process owner remains unresolved",
    {
      reason: "cleanup_incomplete",
      cleanup: {
        reason: "Controlled process cleanup refusal",
        resources: [retainedProcessRoot],
      },
    },
  );
  const originalRetry = ProcessCaptureResourceScope.prototype.retryCleanup;
  // This seam models an already-retained process owner. It never launches or
  // signals a target and does not establish real process-cleanup behavior.
  const retry = vi
    .spyOn(ProcessCaptureResourceScope.prototype, "retryCleanup")
    .mockImplementation(async function (this: ProcessCaptureResourceScope) {
      events.push("process_cleanup");
      if (!cleanupAllowed) throw failure;
      await originalRetry.call(this);
    });
  const admitted = test.session.withAdmittedAnalysis(
    "fixture_metadata_before_reset",
    undefined,
    async () => {
      entered.resolve();
      await release.promise;
      events.push("metadata_drained");
    },
  );
  try {
    await entered.promise;
    const resetting = test.client.callTool({
      name: "reset_investigation",
      arguments: { save_path: path, overwrite: true },
    });
    await test.client.ping();
    expect(retry).not.toHaveBeenCalled();
    release.resolve();
    await admitted;
    expect(parseMcpToolError(await resetting)).toMatchObject({
      error: {
        code: "cleanup_incomplete",
        details: { resources: [retainedProcessRoot] },
      },
    });
    expect(events).toEqual(["metadata_drained", "process_cleanup"]);
    expect((await readFile(path)).equals(originalBytes)).toBe(true);
    expect(await bundle(test.client)).toEqual(seeded.before);
    expect(test.createClient).not.toHaveBeenCalled();

    cleanupAllowed = true;
    const reset = await call(test.client, "reset_investigation", {
      save_path: path,
      overwrite: true,
    });
    expect(reset.structuredContent).toMatchObject({
      result: cleared(seeded.before, false),
    });
    expect(events).toEqual([
      "metadata_drained",
      "process_cleanup",
      "process_cleanup",
    ]);
    expect(
      parseEvidenceBundle(JSON.parse(await readFile(path, "utf8"))),
    ).toEqual(seeded.before);
    expect(await bundle(test.client)).toEqual(createEvidenceBundle([]));
    expect(test.createClient).not.toHaveBeenCalled();
  } finally {
    cleanupAllowed = true;
    release.resolve();
    await admitted;
    retry.mockRestore();
  }
});
