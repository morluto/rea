import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished, vi } from "vitest";

import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import type { RizinDebugToolOptions } from "../../../src/server/serviceToolBindings.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { rizinDebugMcpServer } from "../../fixtures/rizinDebugMcp.js";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { waitFor } from "../../support/testWait.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const commandEvidence = (): Evidence =>
  createEvidence(
    unknownTarget("not-observed"),
    { id: "rizin", name: "Rizin", version: "fixture" },
    {
      operation: "rizin_debug_command",
      parameters: { session_id: SESSION_ID, command: "dr" },
      result: { output: "rip = 0x1000" },
    },
  );

const commandResult = (evidence: Evidence) =>
  ok({
    result: {
      command: "dr",
      output: "rip = 0x1000",
      output_scope: "command_and_interleaved_session_output" as const,
      output_truncated: false,
      completion_status: "complete" as const,
      backend: null,
    },
    evidence,
  });

const unusedManager = (): RizinDebugToolOptions["manager"] => ({
  start: async () => ok({ session_id: SESSION_ID, backend: null }),
  execute: async () => commandResult(commandEvidence()),
  status: () => undefined,
  close: async () => ok({ target_state: "unknown" as const }),
  retryCleanupFailures: async () => ok(null),
});

/** Bind the Rizin tools under a real session's external-mutation admission. */
const connect = async (manager: RizinDebugToolOptions["manager"]) => {
  const session = createTestBinarySession(() => {
    throw new Error("Rizin tools must not start a binary provider");
  });
  const recorded: Evidence[] = [];
  const server = rizinDebugMcpServer(
    "rizin-lifecycle",
    manager,
    session,
    (evidence) => {
      recorded.push(evidence);
      return ok("added" as const);
    },
  );
  const client = new Client({ name: "rizin-lifecycle", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, recorded };
};

/**
 * A failed detach that stays owned until `release()`; the session reads its
 * completion from the claim, as it does from the debugger managers.
 */
const ownedDetachFailure = () => {
  let released = false;
  const error = new AnalysisOutputError(
    "rizin_debug_command",
    "fixture detach failed",
    { cleanup: { reason: "fixture detach failed", resources: [SESSION_ID] } },
  ).bindCleanupReleaseClaim({
    get cleanupReleased() {
      return released;
    },
  });
  return {
    error,
    release: () => {
      released = true;
    },
  };
};

it("retries a failed debugger cleanup before the next command and keeps it owned while it fails", async () => {
  const detach = ownedDetachFailure();
  const manager = unusedManager();
  const execute = vi
    .fn<RizinDebugToolOptions["manager"]["execute"]>()
    .mockResolvedValue(err(detach.error));
  const retry = vi
    .fn<RizinDebugToolOptions["manager"]["retryCleanupFailures"]>()
    .mockResolvedValueOnce(err(detach.error))
    .mockImplementation(async () => {
      detach.release();
      return ok(null);
    });
  const start = vi.spyOn(manager, "start");
  const { client } = await connect({
    ...manager,
    execute,
    retryCleanupFailures: retry,
    start,
  });
  const call = () =>
    client.callTool({
      name: "start_rizin_debug_session",
      arguments: { path: "/fixture/target", inferior_tty: "/dev/null" },
    });

  const failed = await client.callTool({
    name: "rizin_debug_command",
    arguments: { session_id: SESSION_ID, command: "dr" },
  });
  expect(failed.isError).toBe(true);
  const refused = await call();
  expect(refused.isError).toBe(true);
  // The retry ran and failed, so the cleanup stays owned and start waits.
  expect(retry).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();

  const started = await call();
  expect(started.isError ?? false).toBe(false);
  expect(retry).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledOnce();
});

it("keeps a completed command's Evidence when cancellation arrives during final cleanup", async () => {
  const completed = commandEvidence();
  const held = phaseGate();
  onTestFinished(() => held.release());
  const manager = {
    ...unusedManager(),
    execute: async () => {
      await held.hold();
      return commandResult(completed);
    },
  };
  const { client, recorded } = await connect(manager);
  const controller = new AbortController();
  const command = client
    .callTool(
      {
        name: "rizin_debug_command",
        arguments: { session_id: SESSION_ID, command: "dr" },
      },
      { signal: controller.signal },
    )
    .catch(() => undefined);
  await held.reached(command, "Rizin command");
  // The command completes after the caller cancelled; admission observes the
  // cancellation while finishing and keeps the completed observation.
  controller.abort();
  held.release();
  await command;
  await waitFor(() =>
    expect(recorded.map(({ evidence_id }) => evidence_id)).toContain(
      completed.evidence_id,
    ),
  );
});

it("runs an owned close once when it is the cleanup blocking its own admission", async () => {
  const detach = ownedDetachFailure();
  const close = vi
    .fn<RizinDebugToolOptions["manager"]["close"]>()
    .mockResolvedValueOnce(err(detach.error))
    .mockImplementation(async () => {
      detach.release();
      return ok({ target_state: "unknown" as const });
    });
  const retry = vi.fn<RizinDebugToolOptions["manager"]["retryCleanupFailures"]>(
    async () => err(detach.error),
  );
  const { client } = await connect({
    ...unusedManager(),
    close,
    retryCleanupFailures: retry,
  });
  const closeSession = () =>
    client.callTool({
      name: "close_rizin_debug_session",
      arguments: { session_id: SESSION_ID },
    });

  expect((await closeSession()).isError).toBe(true);
  // Another command is refused while the failed close stays owned.
  const command = await client.callTool({
    name: "rizin_debug_command",
    arguments: { session_id: SESSION_ID, command: "dr" },
  });
  expect(command.isError).toBe(true);
  expect(retry).toHaveBeenCalledOnce();

  const retried = await closeSession();
  expect(retried.isError ?? false, JSON.stringify(retried)).toBe(false);
  // The retried close released its own blocker and was not run again.
  expect(close).toHaveBeenCalledTimes(2);
});
