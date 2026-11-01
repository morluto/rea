import { InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isCallToolResult,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { silentLogger } from "../../../src/logger.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { parseMcpEvidenceBundle } from "../../fixtures/mcpEvidenceBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const operationName = "build_call_path";
const source = FUNCTION_COMPARISON_EXAMPLE.left;
const request = {
  name: operationName,
  arguments: {
    start: { address: "0x1000" },
    goal: { address: "0x1000" },
    functions: [source],
  },
};

// The SDK, catalog handler, source parser, ledger and checkpoint are real. The
// authored function dossier requires no provider acquisition or target run.
const fixture = async () => ({
  ...(await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("The target-free call path must not acquire a provider");
    }),
    serverOptions: { environment: {}, logger: silentLogger },
  })),
  root: await createTestTempDirectory("rea-success-publication-"),
});

/** Observe the public session admission port without depending on its private bookkeeping. */
const observeLifecycle = (session: BinarySession, events: string[]) => {
  const resetEntered = createDeferred<void>();
  let activeCalls = 0;
  let resetCompleted = false;
  const originalAdmission = session.withAdmittedAnalysis.bind(session);
  const originalReset = session.resetInvestigation.bind(session);
  const admission = vi
    .spyOn(session, "withAdmittedAnalysis")
    .mockImplementation((name, signal, operation) => {
      const admitted = originalAdmission(name, signal, operation);
      if (name !== operationName) return admitted;
      activeCalls += 1;
      return admitted.finally(() => {
        activeCalls -= 1;
      });
    });
  const reset = vi
    .spyOn(session, "resetInvestigation")
    .mockImplementation((options) => {
      const resetting = originalReset(options);
      resetEntered.resolve();
      return resetting.finally(() => {
        resetCompleted = true;
        events.push("reset-completed");
      });
    });
  return {
    resetEntered: resetEntered.promise,
    get activeCalls() {
      return activeCalls;
    },
    get resetCompleted() {
      return resetCompleted;
    },
    restore: () => {
      admission.mockRestore();
      reset.mockRestore();
    },
  };
};

/** Hold a genuine successful reply below REA's transport wrapper, before physical send. */
const holdPublication = (events: string[]) => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const settled = createDeferred<void>();
  const cancelled = createDeferred<void>();
  const originalSend = InMemoryTransport.prototype.send;
  let heldId: string | number | undefined;
  let offered: Evidence | undefined;
  const send = vi
    .spyOn(InMemoryTransport.prototype, "send")
    .mockImplementation(async function (
      this: InMemoryTransport,
      message,
      options,
    ) {
      if (
        offered === undefined &&
        isJSONRPCResultResponse(message) &&
        isCallToolResult(message.result) &&
        message.result.isError !== true &&
        typeof message.result.structuredContent === "object" &&
        message.result.structuredContent !== null &&
        "operation" in message.result.structuredContent &&
        message.result.structuredContent.operation === operationName
      ) {
        heldId = message.id;
        offered = parseEvidence(message.result.structuredContent);
        entered.resolve();
        try {
          await release.promise;
          await originalSend.call(this, message, options);
          events.push("success-published");
        } finally {
          settled.resolve();
        }
        return;
      }
      await originalSend.call(this, message, options);
      if (
        isJSONRPCNotification(message) &&
        message.method === "notifications/cancelled" &&
        message.params?.["requestId"] === heldId
      )
        cancelled.resolve();
    });
  return {
    entered: entered.promise,
    settled: settled.promise,
    cancelled: cancelled.promise,
    evidence: () => {
      if (offered === undefined)
        throw new Error("No call-path reply reached transport");
      return offered;
    },
    release: () => release.resolve(),
    join: async () => {
      if (offered !== undefined) await settled.promise;
    },
    restore: () => send.mockRestore(),
  };
};

it("keeps successful Evidence admitted through physical publication before a later reset checkpoints it", async () => {
  const test = await fixture();
  const events: string[] = [];
  const lifecycle = observeLifecycle(test.session, events);
  const publication = holdPublication(events);
  const checkpoint = join(test.root, "saved.json");
  const running = test.client.callTool(request);
  let resetting: Promise<CallToolResult> | undefined;
  try {
    await awaitAcknowledgement(
      publication.entered,
      running,
      "successful call-path publication",
    );
    const expected = createEvidenceBundle([source, publication.evidence()]);
    expect(test.session.exportEvidenceBundle()).toEqual(expected);
    resetting = test.client.callTool({
      name: "reset_investigation",
      arguments: { save_path: checkpoint },
    });
    await awaitAcknowledgement(
      lifecycle.resetEntered,
      resetting,
      "reset after successful handler",
    );
    expect(lifecycle.resetCompleted).toBe(false);
    // The old handler-only admission is already settled at this boundary.
    expect(lifecycle.activeCalls).toBeGreaterThan(0);
    await expect(access(checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
    publication.release();
    const [reply, reset] = await Promise.all([running, resetting]);
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(parseEvidence(reply.structuredContent)).toEqual(
      publication.evidence(),
    );
    expect(reset.isError, JSON.stringify(reset)).not.toBe(true);
    expect(events).toEqual(["success-published", "reset-completed"]);
    expect(
      parseEvidenceBundle(JSON.parse(await readFile(checkpoint, "utf8"))),
    ).toEqual(expected);
    const current = await test.client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    expect(parseMcpEvidenceBundle(current)).toEqual(createEvidenceBundle([]));
  } finally {
    publication.release();
    await Promise.allSettled([
      running,
      ...(resetting === undefined ? [] : [resetting]),
    ]);
    publication.restore();
    lifecycle.restore();
    await test.close();
  }
});

it("does not release an already-started successful send when SDK cancellation precedes transport settlement", async () => {
  const test = await fixture();
  const events: string[] = [];
  const lifecycle = observeLifecycle(test.session, events);
  const publication = holdPublication(events);
  const checkpoint = join(test.root, "cancelled-send.json");
  const controller = new AbortController();
  const running = test.client
    .callTool(request, { signal: controller.signal })
    .then(
      (reply) => reply,
      (cause: unknown) => cause,
    );
  let resetting: Promise<CallToolResult> | undefined;
  try {
    await awaitAcknowledgement(
      publication.entered,
      running,
      "cancellable successful publication",
    );
    const expected = createEvidenceBundle([source, publication.evidence()]);
    resetting = test.client.callTool({
      name: "reset_investigation",
      arguments: { save_path: checkpoint },
    });
    await awaitAcknowledgement(
      lifecycle.resetEntered,
      resetting,
      "reset behind cancellable publication",
    );
    controller.abort(
      new Error("Caller cancelled an already-started successful send"),
    );
    await awaitAcknowledgement(
      publication.cancelled,
      publication.settled,
      "successful-send cancellation delivery",
    );
    expect(await running).toMatchObject({
      code: "REQUEST_TIMEOUT",
      message: expect.stringContaining(
        "Caller cancelled an already-started successful send",
      ),
    });
    expect(lifecycle.activeCalls).toBeGreaterThan(0);
    expect(lifecycle.resetCompleted).toBe(false);
    await expect(access(checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
    expect(test.session.exportEvidenceBundle()).toEqual(expected);
    publication.release();
    expect((await resetting).isError).not.toBe(true);
    await publication.join();
    expect(events).toEqual(["success-published", "reset-completed"]);
    expect(
      parseEvidenceBundle(JSON.parse(await readFile(checkpoint, "utf8"))),
    ).toEqual(expected);
    const current = await test.client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    expect(parseMcpEvidenceBundle(current)).toEqual(createEvidenceBundle([]));
  } finally {
    controller.abort();
    publication.release();
    await Promise.allSettled([
      running,
      ...(resetting === undefined ? [] : [resetting]),
    ]);
    await publication.join();
    publication.restore();
    lifecycle.restore();
    await test.close();
  }
});
