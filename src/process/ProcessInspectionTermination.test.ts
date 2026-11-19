import { EventEmitter } from "node:events";
import { expect, it, onTestFinished, vi } from "vitest";

import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import { OwnedCommandFailure, runOwnedCommand } from "./OwnedCommand.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "./ProcessInspectionCancellation.js";
import { retainOwnedCommandCleanup } from "../providers/OwnedCommandCleanup.js";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";
import { terminateTokenOwnedProcesses } from "./TokenOwnedTermination.js";

it("preserves the exact failed inspection descriptor when graceful termination cannot inspect identity", async () => {
  const file = await failedInspectionDescriptor();
  const listProcesses = vi.fn(async () => [
    {
      pid: 42,
      parentPid: 1,
      processGroupId: 42,
      state: "S",
      command: "fixture",
    },
  ]);
  const signalGroup = vi.fn(() => {
    throw new Error("Unexpected group signal");
  });
  const signalProcess = vi.fn(() => {
    throw new Error("Unexpected PID signal");
  });
  const result = await terminateTokenOwnedProcesses(
    { runId: "authored-run", processGroupId: 42 },
    0,
    {
      ownership: {
        platform: "linux",
        listProcesses,
        environment: async () => ({ REA_PROCESS_RUN_ID: "authored-run" }),
        processIdentities: async () => {
          throw file.failure;
        },
        signalGroup,
      },
      signalProcess,
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: { launchGroupSignalled: false },
  });
  if (result.ok)
    throw new Error(
      "Unknown identity must not report successful termination inspection",
    );
  expect(result.error.cause).toBe(file.failure);
  expect(file.handle.fd).toBeGreaterThanOrEqual(0);
  expect(listProcesses).toHaveBeenCalledOnce();
  expect(signalGroup).not.toHaveBeenCalled();
  expect(signalProcess).not.toHaveBeenCalled();
});

it("retries the original inspection descriptor before fresh process cleanup and never reports a blocked close as verified", async () => {
  const file = await failedInspectionDescriptor();
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: null,
    stderr: null,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => {
      throw new Error("Unexpected child signal");
    }),
  });
  let cleanupCalls = 0;
  const supervisor = new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    cleanup: async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw file.failure;
      return { cleaned: true, signaled: false };
    },
  });
  child.emit("close", 0, null);
  onTestFinished(() => supervisor.dispose());
  const initial = await supervisor.stop();
  expect(initial.status).toBe("incomplete");
  if (initial.status !== "incomplete")
    throw new Error("Expected retained inspection cleanup");
  expect(initial.inspectionCleanup?.causes).toEqual([file.failure]);
  const retried = await supervisor.stop();
  expect(retried.status).toBe("incomplete");
  if (retried.status !== "incomplete")
    throw new Error("Expected blocked descriptor retry");
  expect(retried.inspectionCleanup?.causes[0]).toBe(file.failure);
  expect(retried.inspectionCleanup?.failures[0]?.failure).toBe(file.failure);
  expect(retried.inspectionCleanup?.failures[0]?.cause).not.toBe(
    initial.inspectionCleanup?.failures[0]?.cause,
  );
  expect(file.handle.fd).toBeGreaterThanOrEqual(0);
  expect(cleanupCalls).toBe(1);
  file.allow();
  expect((await supervisor.stop()).status).toBe("verified-cleanup");
  expect(file.handle.fd).toBe(-1);
  expect(cleanupCalls).toBe(2);
  expect(child.kill).not.toHaveBeenCalled();
});

it("retries all mixed inspection owners and keeps original and retry errors live until the last exact owner releases", async () => {
  const first = await failedInspectionDescriptor();
  const second = await failedInspectionDescriptor();
  const foreign = await failedInspectionDescriptor();
  const observations = new Map([
    [44, { state: "unavailable" as const, reason: "not yet observed" }],
  ]);
  const batch = new ProcessOwnershipIdentityBatchFailure(
    [
      { pid: 42, requestIndex: 0, cause: first.failure },
      { pid: 42, requestIndex: 1, cause: second.failure },
      {
        pid: 44,
        requestIndex: 2,
        cause: new ProcessOwnershipInspectionCancelled(foreign.failure),
      },
    ],
    observations,
  );
  const child = Object.assign(new EventEmitter(), {
    stdout: null,
    stderr: null,
    exitCode: 0,
    signalCode: null,
    kill: () => {
      throw new Error("Unexpected child signal");
    },
  });
  let cleanupCalls = 0;
  const supervisor = new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    cleanup: async () => {
      if (++cleanupCalls === 1) throw batch;
      return { cleaned: true, signaled: false };
    },
  });
  child.emit("close", 0, null);
  onTestFinished(() => supervisor.dispose());
  const initial = await supervisor.stop();
  if (initial.status !== "incomplete")
    throw new Error("Expected mixed cleanup failure");
  expect(initial.inspectionCleanup?.causes[0]).toBe(batch);
  expect(batch.observations).toBe(observations);
  const command = new OwnedCommandFailure(
    "process",
    "physical command failure",
    null,
    initial.reason,
    {},
    [first.path, second.path],
    supervisor,
  );
  const retained: { close(): Promise<void> }[] = [];
  const errors = retainOwnedCommandCleanup(
    command,
    {
      retain: (owner) => retained.push(owner),
      run: (work) => work(),
    },
    "fixture",
    "inspect",
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.cleanupIncomplete).toBe(true);
  first.allow();
  const partial = await supervisor.stop();
  if (partial.status !== "incomplete")
    throw new Error("Second owner must remain unresolved");
  expect(first.handle.fd).toBe(-1);
  expect(second.handle.fd).toBeGreaterThanOrEqual(0);
  expect(
    partial.inspectionCleanup?.failures.map(({ failure }) => failure),
  ).toEqual([second.failure]);
  expect(partial.inspectionCleanup?.causes[0]).toBe(batch);
  expect(cleanupCalls).toBe(1);
  const firstCloses = first.closes();
  const retryError: unknown = await retained[0]!
    .close()
    .catch((cause: unknown) => cause);
  expect(retryError).toMatchObject({ cleanupIncomplete: true });
  expect(errors[0]?.cleanupIncomplete).toBe(true);
  expect(first.closes()).toBe(firstCloses);
  expect(foreign.closes()).toBe(1);
  second.allow();
  await retained[0]!.close();
  expect(second.handle.fd).toBe(-1);
  expect(first.closes()).toBe(firstCloses);
  expect(cleanupCalls).toBe(2);
  expect(errors[0]?.cleanupIncomplete).toBe(false);
  expect(retryError).toMatchObject({ cleanupIncomplete: false });
  expect(foreign.handle.fd).toBeGreaterThanOrEqual(0);
  expect(foreign.closes()).toBe(1);
});

it("retains stop-only inspection facts on the actual command failure after its supervisor releases the descriptor", async () => {
  const file = await failedInspectionDescriptor();
  const observations = new Map([
    [
      44,
      {
        state: "unavailable" as const,
        reason: "retained identity observation",
      },
    ],
  ]);
  const batch = new ProcessOwnershipIdentityBatchFailure(
    [{ pid: 42, requestIndex: 0, cause: file.failure }],
    observations,
  );
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: null,
    stderr: null,
    exitCode: 0,
    signalCode: null,
    kill: () => {
      throw new Error("Unexpected child signal");
    },
  });
  let cleanupCalls = 0;
  const failure: unknown = await runOwnedCommand(
    { command: "recorded-command", arguments: [], runId: "recorded-run" },
    {
      timeoutMs: null,
      diagnosticBytes: 1024,
    },
    {
      launcher: async () => {
        setImmediate(() => child.emit("close", 0, null));
        return {
          process: child,
          ownership: {
            runId: "recorded-run",
            leaderPid: 42,
            processGroupId: 42,
          },
          cleanup: async () => {
            if (++cleanupCalls === 1) throw batch;
            return { cleaned: true, signaled: false };
          },
        };
      },
    },
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(OwnedCommandFailure);
  if (!(failure instanceof OwnedCommandFailure)) throw failure;
  onTestFinished(() => failure.cleanupOwner?.dispose());
  expect(failure.inspectionCleanup?.causes[0]).toBe(batch);
  expect(failure.inspectionCleanup?.failures[0]?.failure).toBe(file.failure);
  expect(batch.observations).toBe(observations);
  expect(file.handle.fd).toBeGreaterThanOrEqual(0);
  file.allow();
  expect((await failure.cleanupOwner!.stop()).status).toBe("verified-cleanup");
  expect(file.handle.fd).toBe(-1);
  expect(cleanupCalls).toBe(2);
  expect(failure.inspectionCleanup?.causes[0]).toBe(batch);
  const retained = failure.inspectionCleanup?.causes[0];
  if (!(retained instanceof ProcessOwnershipIdentityBatchFailure))
    throw new Error("Expected retained batch after release");
  expect(retained.observations).toBe(observations);
});
