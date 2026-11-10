import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { silentLogger } from "../../../src/logger.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { parseMcpEvidenceBundle } from "../../fixtures/mcpEvidenceBundle.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

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

const currentBundle = async (client: Client) =>
  parseMcpEvidenceBundle(await call(client, "get_evidence_bundle"));

const fixture = async () => {
  const root = await createTestTempDirectory("rea-reset-artifact-cleanup-");
  const source = FUNCTION_COMPARISON_EXAMPLE.left;
  const inputPath = join(root, "fixture.json");
  await writeFile(inputPath, JSON.stringify(createEvidenceBundle([source])));
  const createClient = vi.fn(() => {
    throw new Error("This target-free fixture must not acquire a provider");
  });
  const { client, session } = await createApplicationMcpHarness({
    session: createTestBinarySession(createClient),
    serverOptions: { environment: {}, logger: silentLogger },
  });
  await call(client, "import_evidence_bundle", { path: inputPath });
  const unknownFields = {
    severity: "medium",
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
    supporting_evidence_ids: [source.evidence_id],
    contradicting_evidence_ids: [],
  };
  const { unknown_id } = z
    .object({ result: z.object({ unknown_id: z.string() }) })
    .parse(
      (
        await call(client, "record_unknown", {
          ...unknownFields,
          question: "Which fixture revision supplied this Evidence?",
          domain: "provenance",
        })
      ).structuredContent,
    ).result;
  await call(client, "update_unknown", {
    ...unknownFields,
    unknown_id,
    expected_revision: 1,
    status: "investigating",
    resolution: null,
  });
  const before = await currentBundle(client);
  expect(before.unknowns.map(({ revision }) => revision)).toEqual([1, 2]);
  return { root, client, session, before, createClient };
};

it("drains ordinary exports and refuses reset until their retained artifact owner releases", async () => {
  const { root, client, session, before, createClient } = await fixture();
  const exportPath = join(root, "published.json");
  const checkpointPath = join(root, "caller-checkpoint.json");
  const checkpointBytes = Buffer.from("caller-owned checkpoint");
  await writeFile(checkpointPath, checkpointBytes);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const originalClose = OwnedStagedOutput.prototype.close;
  const originalProcessRetry =
    ProcessCaptureResourceScope.prototype.retryCleanup;
  let retainedOutput: OwnedStagedOutput | undefined;
  let cleanupAllowed = false;
  let processCleanupAllowed = true;
  let cleanupAttempts = 0;
  const processRoot = join(root, "simulated-retained-process-root");
  const processFailure = new ProcessCaptureError(
    "Controlled retained process cleanup refusal",
    {
      reason: "cleanup_incomplete",
      cleanup: {
        reason: "Controlled retained process cleanup refusal",
        resources: [processRoot],
      },
    },
  );
  // The mixed-owner control simulates only the existing process scope's retry
  // result; it never launches or signals a target.
  const retryProcess = vi
    .spyOn(ProcessCaptureResourceScope.prototype, "retryCleanup")
    .mockImplementation(async function (this: ProcessCaptureResourceScope) {
      if (!processCleanupAllowed) throw processFailure;
      await originalProcessRetry.call(this);
    });
  // Only the final cleanup fault is simulated. Public MCP export publishes a
  // real canonical bundle and its actual scope retains the real staging owner.
  const close = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      if (dirname(this.directory) === root && retainedOutput === undefined) {
        await access(exportPath);
        retainedOutput = this;
      }
      if (this === retainedOutput) {
        cleanupAttempts += 1;
        entered.resolve();
        await release.promise;
        if (!cleanupAllowed)
          throw new Error("Controlled ordinary-export staging cleanup refusal");
      }
      await originalClose.call(this);
    });
  const pending: Promise<unknown>[] = [];
  try {
    const exporting = client.callTool({
      name: "export_evidence_bundle",
      arguments: { path: exportPath },
    });
    pending.push(exporting);
    await awaitAcknowledgement(
      entered.promise,
      exporting,
      "ordinary export final cleanup",
    );
    const resetting = client.callTool({
      name: "reset_investigation",
      arguments: {},
    });
    pending.push(resetting);
    await client.ping();
    expect(cleanupAttempts).toBe(1);
    expect(session.immutableEvidenceBundle()).toEqual(before);
    release.resolve();
    expect(parseMcpToolError(await exporting)).toMatchObject({
      error: { code: "cleanup_incomplete" },
    });
    expect(parseMcpToolError(await resetting)).toMatchObject({
      error: {
        code: "cleanup_incomplete",
        details: { resources: [retainedOutput?.directory] },
      },
    });
    expect(cleanupAttempts).toBe(2);
    expect(
      parseEvidenceBundle(JSON.parse(await readFile(exportPath, "utf8"))),
    ).toEqual(before);
    expect(await currentBundle(client)).toEqual(before);

    const saveReset = await client.callTool({
      name: "reset_investigation",
      arguments: { save_path: checkpointPath, overwrite: true },
    });
    expect(parseMcpToolError(saveReset)).toMatchObject({
      error: { code: "cleanup_incomplete" },
    });
    expect(cleanupAttempts).toBe(3);
    expect((await readFile(checkpointPath)).equals(checkpointBytes)).toBe(true);
    expect(await currentBundle(client)).toEqual(before);

    processCleanupAllowed = false;
    const mixed = await client.callTool({
      name: "reset_investigation",
      arguments: {},
    });
    expect(parseMcpToolError(mixed)).toMatchObject({
      error: {
        code: "cleanup_incomplete",
        details: { resources: [processRoot, retainedOutput?.directory] },
      },
    });
    expect(cleanupAttempts).toBe(4);
    expect(await currentBundle(client)).toEqual(before);

    cleanupAllowed = true;
    const processRemaining = await client.callTool({
      name: "reset_investigation",
      arguments: {},
    });
    expect(parseMcpToolError(processRemaining)).toMatchObject({
      error: {
        code: "cleanup_incomplete",
        details: { resources: [processRoot] },
      },
    });
    expect(cleanupAttempts).toBe(5);
    expect(await currentBundle(client)).toEqual(before);

    processCleanupAllowed = true;
    expect(
      (await call(client, "reset_investigation")).structuredContent,
    ).toEqual({
      result: {
        cleared_evidence_records: before.records.length,
        cleared_unknown_revisions: before.unknowns.length,
        cleared_unknown_heads: 1,
        retained_target: false,
      },
    });
    expect(cleanupAttempts).toBe(5);
    expect(await currentBundle(client)).toEqual(createEvidenceBundle([]));
    // Reset retries the shared scope without closing it: a fresh import/export
    // still works, including both original Unknown revisions and Evidence IDs.
    await call(client, "import_evidence_bundle", { path: exportPath });
    const restoredPath = join(root, "restored.json");
    await call(client, "export_evidence_bundle", { path: restoredPath });
    expect(
      parseEvidenceBundle(JSON.parse(await readFile(restoredPath, "utf8"))),
    ).toEqual(before);
    expect(createClient).not.toHaveBeenCalled();
  } finally {
    cleanupAllowed = true;
    processCleanupAllowed = true;
    release.resolve();
    await Promise.allSettled(pending);
    close.mockRestore();
    retryProcess.mockRestore();
  }
});
