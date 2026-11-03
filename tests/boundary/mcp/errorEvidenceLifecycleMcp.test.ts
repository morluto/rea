import { InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isCallToolResult,
  isJSONRPCResultResponse,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { createEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { silentLogger } from "../../../src/logger.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { withAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Public SDK validation, transport recovery, ledger and checkpoint owners are
// real. This fixture requires no target or simulated provider execution.
const fixture = () =>
  createApplicationMcpHarness({
    serverOptions: {
      logger: silentLogger,
      delivery: createToolResultDelivery(4096),
      environment: {
        REA_MCP_MAX_INPUT_ELEMENTS: "1024",
      },
    },
  });

const invalidKey = `unexpected_${"x".repeat(6_000)}`;
const invalidRequest = {
  name: "procedure_pseudo_code",
  arguments: { [invalidKey]: true },
};
const retainedReference = (reply: CallToolResult): string => {
  const projected = parseMcpToolError(reply).error;
  expect(projected.code).toBe("resource_constraint");
  return z
    .object({
      evidence_reference: z.object({
        kind: z.literal("retained-evidence"),
        evidence_id: z.string(),
      }),
    })
    .parse(projected.details?.reported_limits).evidence_reference.evidence_id;
};
const readBundle = async (path: string) =>
  parseEvidenceBundle(JSON.parse(await readFile(path, "utf8")));

const authoredRecord = () =>
  createEvidence(
    undefined,
    {
      id: "fixture",
      name: "Authored request publication fixture",
      version: "1",
    },
    { operation: "fixture_publication", parameters: {}, result: true },
  );

const customFixture = () => {
  const session = createTestBinarySession(createCacheProvider([]));
  const delivery = createToolResultDelivery(4096);
  const server = new EvidenceMcpServer(
    { name: "request-publication-fixture", version: "1" },
    { capabilities: {} },
    (evidence) => session.recordEvidence(evidence),
    delivery,
  );
  const admit = withAdmittedAnalysis({ kind: "session", session });
  return {
    session,
    server,
    admit,
    delivery,
    connect: () =>
      createApplicationMcpHarness({
        session,
        serverOptions: {
          mcpServer: server,
          delivery,
          logger: silentLogger,
          environment: { REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
        },
      }),
  };
};

it("publishes an oversized validation-error reference only after an earlier reset finishes", async () => {
  const test = await fixture();
  const root = await createTestTempDirectory("rea-error-after-reset-");
  const checkpoint = join(root, "previous.json");
  const exported = join(root, "current.json");
  const previous = createEvidence(
    undefined,
    { id: "fixture", name: "Authored retained observation", version: "1" },
    { operation: "fixture_observation", parameters: {}, result: true },
  );
  expect(test.session.recordEvidence(previous).ok).toBe(true);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const queued = createDeferred<void>();
  const originalClose = OwnedStagedOutput.prototype.close;
  const originalAdmission = test.session.withAdmittedAnalysis.bind(
    test.session,
  );
  const close = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      await originalClose.call(this);
      if (dirname(this.directory) === root) {
        entered.resolve();
        await release.promise;
      }
    });
  const admission = vi
    .spyOn(test.session, "withAdmittedAnalysis")
    .mockImplementation((operationName, signal, operation) => {
      const admitted = originalAdmission(operationName, signal, operation);
      if (operationName === invalidRequest.name) queued.resolve();
      return admitted;
    });
  const resetting = test.client.callTool({
    name: "reset_investigation",
    arguments: { save_path: checkpoint },
  });
  let invalid: Promise<CallToolResult> | undefined;
  try {
    await awaitAcknowledgement(
      entered.promise,
      resetting,
      "checkpoint cleanup",
    );
    invalid = test.client.callTool(invalidRequest);
    await awaitAcknowledgement(
      queued.promise,
      invalid,
      "queued error recovery",
    );
    expect(test.session.exportEvidenceBundle().records).toEqual([previous]);
    release.resolve();
    const [reset, reply] = await Promise.all([resetting, invalid]);
    expect(reset.isError, JSON.stringify(reset)).not.toBe(true);
    const id = retainedReference(reply);
    // A returned reference belongs to the new investigation, and can actually
    // be exported through the public operation after the reset has completed.
    const exportReply = await test.client.callTool({
      name: "export_evidence_bundle",
      arguments: { path: exported },
    });
    expect(exportReply.isError, JSON.stringify(exportReply)).not.toBe(true);
    expect((await readBundle(checkpoint)).records).toEqual([previous]);
    const current = await readBundle(exported);
    expect(current.records).toHaveLength(1);
    expect(current.records[0]).toMatchObject({
      evidence_id: id,
      operation: "mcp_tool_error",
      raw_result: { content: [{ text: expect.stringContaining(invalidKey) }] },
    });
  } finally {
    release.resolve();
    await Promise.allSettled([
      resetting,
      ...(invalid === undefined ? [] : [invalid]),
    ]);
    admission.mockRestore();
    close.mockRestore();
    await test.close();
  }
});

it("drains retained error publication before checkpointing a later reset", async () => {
  const test = await fixture();
  const root = await createTestTempDirectory("rea-error-before-reset-");
  const checkpoint = join(root, "saved.json");
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const resettingEntered = createDeferred<void>();
  const originalSend = InMemoryTransport.prototype.send;
  const originalReset = test.session.resetInvestigation.bind(test.session);
  let held = false;
  const publication = vi
    .spyOn(InMemoryTransport.prototype, "send")
    .mockImplementation(async function (
      this: InMemoryTransport,
      message,
      options,
    ) {
      if (
        !held &&
        isJSONRPCResultResponse(message) &&
        isCallToolResult(message.result) &&
        message.result.isError === true
      ) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      await originalSend.call(this, message, options);
    });
  const reset = vi
    .spyOn(test.session, "resetInvestigation")
    .mockImplementation((options) => {
      const resetting = originalReset(options);
      resettingEntered.resolve();
      return resetting;
    });
  const invalid = test.client.callTool(invalidRequest);
  let resetting: Promise<CallToolResult> | undefined;
  try {
    await awaitAcknowledgement(entered.promise, invalid, "error publication");
    expect(test.session.exportEvidenceBundle().records).toHaveLength(1);
    resetting = test.client.callTool({
      name: "reset_investigation",
      arguments: { save_path: checkpoint },
    });
    await awaitAcknowledgement(
      resettingEntered.promise,
      resetting,
      "later reset admission",
    );
    release.resolve();
    const [reply, cleared] = await Promise.all([invalid, resetting]);
    const id = retainedReference(reply);
    expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
    const saved = await readBundle(checkpoint);
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({ evidence_id: id });
    expect(test.session.exportEvidenceBundle().records).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([
      invalid,
      ...(resetting === undefined ? [] : [resetting]),
    ]);
    reset.mockRestore();
    publication.mockRestore();
    await test.close();
  }
});

it("does not retain or offer a validation-error reference after shutdown admission closes", async () => {
  const test = await fixture();
  try {
    test.session.beginShutdown();
    const reply = await test.client.callTool(invalidRequest);
    const projected = parseMcpToolError(reply).error;
    expect(projected.code).toBe("cancelled");
    expect(projected.details).not.toHaveProperty(
      "reported_limits.evidence_reference",
    );
    expect(test.session.exportEvidenceBundle().records).toEqual([]);
  } finally {
    await test.close();
  }
});

it("cancels queued SDK error recovery before it can write into the next investigation", async () => {
  const test = await fixture();
  const root = await createTestTempDirectory("rea-error-reset-cancellation-");
  const checkpoint = join(root, "saved.json");
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const queued = createDeferred<void>();
  const cancelled = createDeferred<void>();
  const originalClose = OwnedStagedOutput.prototype.close;
  const originalAdmission = test.session.withAdmittedAnalysis.bind(
    test.session,
  );
  const close = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      await originalClose.call(this);
      if (dirname(this.directory) === root) {
        entered.resolve();
        await release.promise;
      }
    });
  const admission = vi
    .spyOn(test.session, "withAdmittedAnalysis")
    .mockImplementation((operationName, signal, operation) => {
      const admitted = originalAdmission(operationName, signal, operation);
      if (operationName === invalidRequest.name) {
        signal?.addEventListener("abort", () => cancelled.resolve(), {
          once: true,
        });
        queued.resolve();
      }
      return admitted;
    });
  const controller = new AbortController();
  const resetting = test.client.callTool({
    name: "reset_investigation",
    arguments: { save_path: checkpoint },
  });
  let invalid: Promise<unknown> | undefined;
  try {
    await awaitAcknowledgement(
      entered.promise,
      resetting,
      "checkpoint cleanup",
    );
    invalid = test.client
      .callTool(invalidRequest, { signal: controller.signal })
      .then(
        (reply) => reply,
        (cause: unknown) => cause,
      );
    await awaitAcknowledgement(
      queued.promise,
      invalid,
      "queued cancellable recovery",
    );
    controller.abort(new Error("Caller cancelled queued validation recovery"));
    await awaitAcknowledgement(
      cancelled.promise,
      test.client.ping(),
      "transport cancellation notification",
    );
    expect(await invalid).toMatchObject({
      message: expect.stringContaining(
        "Caller cancelled queued validation recovery",
      ),
    });
    release.resolve();
    expect((await resetting).isError).not.toBe(true);
    // A public read after reset confirms the new investigation has no late write.
    const current = await test.client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    expect(current.isError, JSON.stringify(current)).not.toBe(true);
    expect(test.session.exportEvidenceBundle().records).toEqual([]);
    expect((await readBundle(checkpoint)).records).toEqual([]);
  } finally {
    controller.abort();
    release.resolve();
    await Promise.allSettled([
      resetting,
      ...(invalid === undefined ? [] : [invalid]),
    ]);
    admission.mockRestore();
    close.mockRestore();
    await test.close();
  }
});

it.each(["handler throws", "output fails validation"] as const)(
  "settles original admission when the SDK reports that %s",
  async (failure) => {
    const fixture = customFixture();
    const record = authoredRecord();
    fixture.server.registerTool(
      "fixture_publication",
      {
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ accepted: z.literal(true) }),
      },
      async (_input, context) => {
        const admitted = await fixture.admit(
          "fixture_publication",
          context.mcpReq.signal,
          async () => {
            const recorded = fixture.session.recordEvidence(record);
            if (!recorded.ok) throw recorded.error;
            if (failure === "handler throws")
              throw new Error("Fixture handler exception");
            return null;
          },
        );
        if (!admitted.ok)
          return fixture.delivery.toErrorToolResult(admitted.error, false);
        return { content: [], structuredContent: { accepted: false } };
      },
    );
    const test = await fixture.connect();
    const root = await createTestTempDirectory("rea-sdk-error-publication-");
    const path = join(root, "saved.json");
    try {
      const reply = await test.client
        .callTool({ name: "fixture_publication", arguments: {} })
        .then(
          (result) => result,
          (cause: unknown) => cause,
        );
      if (reply instanceof Error)
        expect(reply.message.length).toBeGreaterThan(0);
      else expect(reply).toMatchObject({ isError: true });
      const reset = await test.client.callTool({
        name: "reset_investigation",
        arguments: { save_path: path },
      });
      expect(reset.isError, JSON.stringify(reset)).not.toBe(true);
      expect((await readBundle(path)).records).toContainEqual(record);
      expect(test.session.exportEvidenceBundle().records).toEqual([]);
    } finally {
      await test.close();
    }
  },
);

it("waits for handler cleanup when cancellation suppresses its unsent SDK reply", async () => {
  const fixture = customFixture();
  const record = authoredRecord();
  const entered = createDeferred<void>();
  const cleanupEntered = createDeferred<void>();
  const release = createDeferred<void>();
  fixture.server.registerTool(
    "fixture_publication",
    { inputSchema: z.strictObject({}) },
    async (_input, context) => {
      const admitted = await fixture.admit(
        "fixture_publication",
        context.mcpReq.signal,
        async () => {
          const recorded = fixture.session.recordEvidence(record);
          if (!recorded.ok) throw recorded.error;
          try {
            // Opposite RPC directions may reuse IDs. Outbound pings are not
            // publication of this tool's eventual, cancellable response.
            const requestId = context.mcpReq.id;
            if (typeof requestId !== "number")
              throw new Error(
                "Expected the fixture client's numeric request ID",
              );
            for (let index = 0; index <= requestId; index += 1)
              await context.mcpReq.send({ method: "ping" });
            entered.resolve();
            await new Promise<void>((resolve) =>
              context.mcpReq.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          } finally {
            cleanupEntered.resolve();
            await release.promise;
          }
          return null;
        },
      );
      return admitted.ok
        ? { content: [{ type: "text", text: "completed fixture cleanup" }] }
        : fixture.delivery.toErrorToolResult(admitted.error, false);
    },
  );
  const test = await fixture.connect();
  const root = await createTestTempDirectory("rea-cancelled-handler-cleanup-");
  const path = join(root, "saved.json");
  const resetEntered = createDeferred<void>();
  const originalReset = test.session.resetInvestigation.bind(test.session);
  const reset = vi
    .spyOn(test.session, "resetInvestigation")
    .mockImplementation((options) => {
      const resetting = originalReset(options);
      resetEntered.resolve();
      return resetting;
    });
  const controller = new AbortController();
  const operation = test.client
    .callTool(
      { name: "fixture_publication", arguments: {} },
      { signal: controller.signal },
    )
    .then(
      (reply) => reply,
      (cause: unknown) => cause,
    );
  let resetting: Promise<CallToolResult> | undefined;
  try {
    await awaitAcknowledgement(
      entered.promise,
      operation,
      "fixture handler admission",
    );
    controller.abort(new Error("Cancel before handler cleanup"));
    await awaitAcknowledgement(
      cleanupEntered.promise,
      test.client.ping(),
      "cancelled handler cleanup",
    );
    resetting = test.client.callTool({
      name: "reset_investigation",
      arguments: { save_path: path },
    });
    await awaitAcknowledgement(
      resetEntered.promise,
      resetting,
      "reset after suppressed reply",
    );
    expect(test.session.exportEvidenceBundle().records).toEqual([record]);
    release.resolve();
    expect((await resetting).isError).not.toBe(true);
    expect((await readBundle(path)).records).toEqual([record]);
    expect(test.session.exportEvidenceBundle().records).toEqual([]);
  } finally {
    controller.abort();
    release.resolve();
    await Promise.allSettled([
      operation,
      ...(resetting === undefined ? [] : [resetting]),
    ]);
    reset.mockRestore();
    await test.close();
  }
});
