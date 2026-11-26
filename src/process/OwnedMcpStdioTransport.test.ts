import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";

import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import { ProcessOwnershipIdentityBatchFailure } from "./ProcessInspectionCancellation.js";
import {
  OwnedMcpStdioTransport,
  type OwnedMcpLauncher,
} from "./OwnedMcpStdioTransport.js";

const transport = (launcher: OwnedMcpLauncher) =>
  new OwnedMcpStdioTransport(
    { command: "/fixture/server", arguments: [] },
    { provider: "fixture", label: "Fixture MCP", maxFrameBytes: 1024 },
    launcher,
  );

it("releases independent preparation owners and reports only those still retained", async () => {
  const pending = await failedInspectionDescriptor();
  const releasable = await failedInspectionDescriptor();
  releasable.allow();
  let closeFails = true;
  let closes = 0;
  const preparation = new DarwinProcessOwnershipInspectionError(
    "ownership-helper preparation was cancelled",
    {
      cleanupOwner: {
        close: async () => {
          closes += 1;
          if (closeFails) throw new Error("helper directory still in use");
        },
      },
    },
  );
  const launchFailure = new ProcessOwnershipIdentityBatchFailure(
    [preparation, pending.failure, releasable.failure].map(
      (cause, requestIndex) => ({
        pid: requestIndex + 1,
        requestIndex,
        cause,
      }),
    ),
    new Map(),
  );
  const owned = transport(async () => {
    throw launchFailure;
  });
  await expect(owned.start()).rejects.toBe(launchFailure);

  const first = await owned.close().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(releasable.handle.fd).toBe(-1);
  if (!(first instanceof ProviderCleanupError)) throw first;
  const failure = first;
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.cause).toBe(launchFailure);
  expect(failure.cleanupResources).toEqual([
    "process ownership inspection",
    pending.path,
  ]);
  expect(failure.diagnostics?.reason).toContain(
    "helper directory still in use",
  );
  expect(failure.diagnostics?.reason).toContain(
    "controlled inspection descriptor close failure",
  );

  closeFails = false;
  await expect(owned.close()).rejects.toMatchObject({
    cleanupResources: [pending.path],
  });
  expect(failure.cleanupResources).toEqual([pending.path]);

  pending.allow();
  await expect(owned.close()).resolves.toBeUndefined();
  expect(pending.handle.fd).toBe(-1);
  expect(failure.cleanupIncomplete).toBe(false);
  expect(closes).toBe(2);
  expect(releasable.closes()).toBe(2);
});

it("reports a failed launch's preparation cleanup failure that names no owner", async () => {
  const preparation = new DarwinProcessOwnershipInspectionError(
    "ownership-helper preparation failed",
    {
      cleanupFailure: new ProviderCleanupError("fixture", ["helper root"], {
        reason: "unremovable",
      }),
    },
  );
  const owned = transport(async () => {
    throw preparation;
  });
  await expect(owned.start()).rejects.toBe(preparation);
  await expect(owned.close()).rejects.toBeInstanceOf(ProviderCleanupError);
  await expect(owned.close()).rejects.toMatchObject({
    cause: preparation,
    cleanupIncomplete: true,
    cleanupResources: ["process ownership inspection"],
  });
});

it("closes cleanly after a launch failure that transferred no cleanup", async () => {
  const owned = transport(async () => {
    throw new Error("command not found");
  });
  await expect(owned.start()).rejects.toThrow("command not found");
  await expect(owned.close()).resolves.toBeUndefined();
});

it("stops delivering queued frames in the same chunk once onmessage closes the transport and fires onclose once across retries", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: 99999,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill: () => true,
  });
  let cleanupFails = true;
  const owned = new OwnedMcpStdioTransport(
    { command: "/fixture/server", arguments: [] },
    {
      provider: "fixture",
      label: "Fixture MCP",
      maxFrameBytes: 4096,
      gracefulInputCloseMs: 5,
    },
    async () => ({
      process: child as never,
      ownership: { runId: "run-1", leaderPid: 99999, processGroupId: 99999 },
      cleanup: async () => {
        if (cleanupFails)
          return { cleaned: false as const, reason: "still alive" };
        child.exitCode = 0;
        child.emit("exit", 0, null);
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
        return { cleaned: true, signaled: false };
      },
    }),
  );
  await owned.start();
  let closeNotifications = 0;
  const seenIds: unknown[] = [];
  owned.onclose = () => {
    closeNotifications += 1;
  };
  owned.onmessage = (message) => {
    seenIds.push("id" in message ? message.id : undefined);
    void owned.close();
  };
  const frame1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
  const frame2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
  stdout.push(`${frame1}\n${frame2}\n`);
  await expect(owned.close()).rejects.toBeInstanceOf(ProviderCleanupError);
  expect(seenIds).toEqual([1]);
  expect(closeNotifications).toBe(1);

  cleanupFails = false;
  await expect(owned.close()).resolves.toBeUndefined();
  expect(closeNotifications).toBe(1);
});

it.each([
  { notifyOnExit: undefined, notifiedBy: "close" },
  { notifyOnExit: true, notifiedBy: "exit" },
] as const)(
  "notifies onclose once when the server $notifiedBy happens before close",
  async ({ notifyOnExit }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      pid: 99999,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill: () => true,
    });
    const owned = new OwnedMcpStdioTransport(
      { command: "/fixture/server", arguments: [] },
      {
        provider: "fixture",
        label: "Fixture MCP",
        maxFrameBytes: 4096,
        ...(notifyOnExit === undefined ? {} : { notifyOnExit }),
      },
      async () => ({
        process: child as never,
        ownership: { runId: "run-1", leaderPid: 99999, processGroupId: 99999 },
        cleanup: async () => ({ cleaned: true, signaled: false }),
      }),
    );
    await owned.start();
    let closeNotifications = 0;
    owned.onclose = () => {
      closeNotifications += 1;
    };
    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
    child.emit("close", 0, null);

    expect(closeNotifications).toBe(1);
    expect(owned.observedFailure()).toEqual({ kind: "exit" });
    await expect(owned.close()).resolves.toBeUndefined();
    expect(closeNotifications).toBe(1);
  },
);
