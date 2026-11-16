import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { err, ok, type Result } from "../../../src/domain/result.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import type { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import type { ExternalMutationAdmission } from "../../../src/server/externalMutationAdmission.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import {
  cutterMcpServer,
  gdbMcpServer,
  rizinDebugMcpServer,
} from "../../fixtures/debuggerMcp.js";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { waitFor } from "../../support/testWait.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

type RecordEvidence = (evidence: Evidence) => Result<"added", AnalysisError>;

/**
 * The debugger operations each lifecycle regression drives, independent of
 * the debugger's own manager or bridge shape.
 */
interface Operations {
  readonly start: () => Promise<Result<unknown, AnalysisError>>;
  readonly execute: () => Promise<Result<Evidence, AnalysisError>>;
  readonly close: () => Promise<
    Result<{ readonly target_state: "unknown" }, AnalysisError>
  >;
  readonly retryCleanup: () => Promise<Result<null, AnalysisError>>;
}

interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

/** One debugger family bound on the external-mutation kind. */
interface Debugger {
  readonly name: string;
  readonly evidence: () => Evidence;
  readonly serve: (
    operations: Operations,
    session: ExternalMutationAdmission,
    recordEvidence: RecordEvidence,
  ) => EvidenceMcpServer;
  /** The command that observes through the owned debugger. */
  readonly command: ToolCall;
  /** The next mutation the cleanup retry gates, and the operation it runs. */
  readonly next: { readonly call: ToolCall; readonly runs: keyof Operations };
  /** The owned close, when the debugger owns a closable session. */
  readonly close?: ToolCall;
}

const commandEvidence = (
  provider: { readonly id: string; readonly name: string },
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
  result: Readonly<Record<string, JsonValue>>,
): Evidence =>
  createEvidence(
    unknownTarget("not-observed"),
    { ...provider, version: "fixture" },
    {
      predicateType: "rea.debugger.command-observation",
      operation,
      parameters,
      result,
    },
  );

const RIZIN: Debugger = {
  name: "Rizin",
  evidence: () =>
    commandEvidence(
      { id: "rizin", name: "Rizin" },
      "rizin_debug_command",
      { session_id: SESSION_ID, command: "dr" },
      {
        command: "dr",
        output: "rip = 0x1000",
        output_scope: "command_and_interleaved_session_output",
        output_truncated: false,
        completion_status: "complete",
        backend: null,
      },
    ),
  serve: (operations, session, recordEvidence) =>
    rizinDebugMcpServer(
      "rizin-lifecycle",
      {
        start: async () => {
          const started = await operations.start();
          return started.ok
            ? ok({ session_id: SESSION_ID, backend: null })
            : started;
        },
        execute: async () => {
          const executed = await operations.execute();
          return executed.ok
            ? // The tools deliver only the Evidence.
              ok({ result: null as never, evidence: executed.value })
            : executed;
        },
        status: () => undefined,
        close: () => operations.close(),
        retryCleanupFailures: () => operations.retryCleanup(),
      },
      session,
      recordEvidence,
    ),
  command: {
    name: "rizin_debug_command",
    arguments: { session_id: SESSION_ID, command: "dr" },
  },
  next: {
    call: {
      name: "start_rizin_debug_session",
      arguments: { path: "/fixture/target", inferior_tty: "/dev/null" },
    },
    runs: "start",
  },
  close: {
    name: "close_rizin_debug_session",
    arguments: { session_id: SESSION_ID },
  },
};

const GDB_CONSOLE = { session_id: SESSION_ID, command: "info registers" };

const GDB: Debugger = {
  name: "GDB",
  evidence: () =>
    commandEvidence(
      { id: "gnu.gdb", name: "GNU GDB" },
      "gdb_console",
      GDB_CONSOLE,
      {
        command: GDB_CONSOLE.command,
        mi: "1^done",
        records: ["1^done"],
        console: "",
        target: "",
        log: "",
        process_exit_observed: false,
        process_exit_code: null,
        process_exit_signal: null,
        output_truncated: false,
        completion_status: "complete",
      },
    ),
  serve: (operations, session, recordEvidence) =>
    gdbMcpServer(
      "gdb-lifecycle",
      {
        start: async () => {
          const started = await operations.start();
          return started.ok
            ? ok({ session_id: SESSION_ID, mi_version: "mi3" as const })
            : started;
        },
        execute: async () => {
          const executed = await operations.execute();
          return executed.ok
            ? // The tools deliver only the Evidence.
              ok({ result: null as never, evidence: executed.value })
            : executed;
        },
        status: () => undefined,
        close: () => operations.close(),
        retryCleanupFailures: () => operations.retryCleanup(),
      },
      session,
      { recordEvidence },
    ),
  command: { name: "gdb_console", arguments: GDB_CONSOLE },
  next: {
    call: { name: "gdb_console", arguments: GDB_CONSOLE },
    runs: "execute",
  },
  close: { name: "close_gdb_session", arguments: { session_id: SESSION_ID } },
};

const CUTTER_COMMAND = {
  session_id: SESSION_ID,
  expected_generation: 1,
  command: "i",
};

const CUTTER: Debugger = {
  name: "Cutter",
  evidence: () =>
    commandEvidence(
      { id: "cutter", name: "Cutter" },
      "cutter_command",
      CUTTER_COMMAND,
      {
        command: "i",
        output: "fixture",
        execution_state: "complete",
        error: null,
        message: null,
        output_truncated: false,
        cutter_version: null,
        current_file: null,
        document_generation: 1,
        identity_status: "partial",
      },
    ),
  serve: (operations, session, recordEvidence) =>
    cutterMcpServer(
      "cutter-lifecycle",
      {
        listSessions: async () => {
          throw new Error("The lifecycle regressions do not discover sessions");
        },
        execute: () => operations.execute(),
        retryCleanup: () => operations.retryCleanup(),
      },
      session,
      recordEvidence,
    ),
  command: { name: "cutter_command", arguments: CUTTER_COMMAND },
  next: {
    call: { name: "cutter_command", arguments: CUTTER_COMMAND },
    runs: "execute",
  },
};

/**
 * A failed detach that stays owned until `release()`; the session reads its
 * completion from the claim, as it does from the debugger managers.
 */
const ownedDetachFailure = (operation: string) => {
  let released = false;
  const error = new AnalysisOutputError(operation, "fixture detach failed", {
    cleanup: { reason: "fixture detach failed", resources: [SESSION_ID] },
  }).bindCleanupReleaseClaim({
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

describe.each([RIZIN, GDB, CUTTER])(
  "$name under external-mutation admission",
  (debuggerTools) => {
    /** Bind the debugger's tools under a real session's admission. */
    const connect = async (
      overrides: Partial<Operations>,
      session = createTestBinarySession(() => {
        throw new Error("Debugger tools must not start a binary provider");
      }),
    ) => {
      const operations: Operations = {
        start: async () => ok(null),
        execute: async () => ok(debuggerTools.evidence()),
        close: async () => ok({ target_state: "unknown" as const }),
        retryCleanup: async () => ok(null),
        ...overrides,
      };
      const recorded: Evidence[] = [];
      const server = debuggerTools.serve(operations, session, (evidence) => {
        recorded.push(evidence);
        return ok("added" as const);
      });
      const client = new Client(
        { name: "debugger-lifecycle", version: "1" },
        { jsonSchemaValidator: createMcpSchemaValidation() },
      );
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

    it("retries a failed debugger cleanup before the next mutation and keeps it owned while it fails", async () => {
      const detach = ownedDetachFailure(debuggerTools.command.name);
      const execute = vi
        .fn<Operations["execute"]>()
        .mockResolvedValueOnce(err(detach.error))
        .mockImplementation(async () => ok(debuggerTools.evidence()));
      const start = vi.fn<Operations["start"]>(async () => ok(null));
      const retryCleanup = vi
        .fn<Operations["retryCleanup"]>()
        .mockResolvedValueOnce(err(detach.error))
        .mockImplementation(async () => {
          detach.release();
          return ok(null);
        });
      const operations = { execute, start, retryCleanup };
      const { client } = await connect(operations);
      const next = operations[debuggerTools.next.runs as "execute" | "start"];

      const failed = await client.callTool(debuggerTools.command);
      expect(failed.isError).toBe(true);
      const nextCalls = next.mock.calls.length;
      const refused = await client.callTool(debuggerTools.next.call);
      expect(refused.isError).toBe(true);
      // The retry ran and failed, so the cleanup stays owned and the next
      // mutation waits.
      expect(retryCleanup).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledTimes(nextCalls);

      const admitted = await client.callTool(debuggerTools.next.call);
      expect(admitted.isError ?? false, JSON.stringify(admitted)).toBe(false);
      expect(retryCleanup).toHaveBeenCalledTimes(2);
      expect(next).toHaveBeenCalledTimes(nextCalls + 1);
    });

    it("keeps a completed command's Evidence when cancellation arrives during final cleanup", async () => {
      // A bound analysis target whose provider close (the retirement after
      // the command) is held, so cancellation lands during final cleanup.
      const [target] = await createBinarySessionTargets();
      const retiring = phaseGate();
      onTestFinished(() => retiring.release());
      const session = createTestBinarySession(
        () =>
          ({
            execute: async () => ok({ operation: "health", value: null }),
            close: async () => {
              await retiring.hold();
              return ok(null);
            },
          }) as never,
      );
      expect((await session.open(target)).ok).toBe(true);
      const completed = debuggerTools.evidence();
      const execute = vi.fn(async () => ok(completed));
      const { client, recorded } = await connect({ execute }, session);
      const controller = new AbortController();
      const command = client
        .callTool(debuggerTools.command, { signal: controller.signal })
        .catch(() => undefined);
      await retiring.reached(command, "analysis retirement close");
      expect(execute).toHaveBeenCalledOnce();
      controller.abort();
      retiring.release();
      await command;
      // Retirement still completes, and the completed command's Evidence is
      // retained through the session writer as the cancellation's partial.
      await waitFor(() =>
        expect(recorded.map(({ evidence_id }) => evidence_id)).toContain(
          completed.evidence_id,
        ),
      );
      expect(session.activeTarget()).toBeUndefined();
    });

    it.runIf(debuggerTools.close !== undefined)(
      "runs an owned close once when it is the cleanup blocking its own admission",
      async () => {
        const closeCall = debuggerTools.close!;
        const detach = ownedDetachFailure(closeCall.name);
        const close = vi
          .fn<Operations["close"]>()
          .mockResolvedValueOnce(err(detach.error))
          .mockImplementation(async () => {
            detach.release();
            return ok({ target_state: "unknown" as const });
          });
        const retryCleanup = vi.fn<Operations["retryCleanup"]>(async () =>
          err(detach.error),
        );
        const { client } = await connect({ close, retryCleanup });

        expect((await client.callTool(closeCall)).isError).toBe(true);
        // Another command is refused while the failed close stays owned.
        const command = await client.callTool(debuggerTools.command);
        expect(command.isError).toBe(true);
        expect(retryCleanup).toHaveBeenCalledOnce();

        const retried = await client.callTool(closeCall);
        expect(retried.isError ?? false, JSON.stringify(retried)).toBe(false);
        // The retried close released its own blocker and was not run again.
        expect(close).toHaveBeenCalledTimes(2);
      },
    );
  },
);
