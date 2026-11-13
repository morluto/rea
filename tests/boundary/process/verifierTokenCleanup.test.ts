import { randomUUID } from "node:crypto";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { resolveSwiftcCompileTimeoutMs } from "../../../src/process/DarwinProcessRunTokenReader.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../../../src/domain/analysisResourceLimits.js";
import {
  createSystemProcessOwnershipHost,
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
  signalProcessWithStartIdentity,
} from "../../../src/process/ProcessOwnershipObservation.js";
import { expect, it, vi } from "vitest";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { prepareVerifierTokenCleanup } from "../../../scripts/lib/verifier-token-cleanup.mjs";
import type {
  ProcessOwnershipHost,
  ProcessIdentityObservation,
  ProcessTableEntry,
} from "../../../src/process/ProcessOwnership.js";

function providerRecoveryFixture() {
  const launcher: ProcessTableEntry = {
    pid: 100,
    parentPid: 50,
    processGroupId: 100,
    state: "S",
    command: "verifier",
  };
  const orphan: ProcessTableEntry = {
    pid: 200,
    parentPid: 1,
    processGroupId: 200,
    state: "S",
    command: "Ghidra control",
  };
  const foreign: ProcessTableEntry = {
    pid: 300,
    parentPid: 1,
    processGroupId: 300,
    state: "S",
    command: "unrelated",
  };
  const wrapper: ProcessTableEntry = {
    ...launcher,
    pid: 101,
    parentPid: launcher.pid,
    command: "MCP wrapper",
  };
  const unrelated = { ...foreign, pid: 301, processGroupId: 301 };
  const tokens = new Map([
    [orphan.pid, "provider-run"],
    [foreign.pid, "foreign-run"],
    [wrapper.pid, "owned-run"],
    [unrelated.pid, "foreign-run"],
  ]);
  let rows = [launcher];
  const close = vi.fn();
  const signalGroup = vi.fn((groupId: number) => {
    rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
  });
  const host: ProcessOwnershipHost = {
    platform: "linux",
    prepare: vi.fn(),
    close,
    captureBaseline: async () => [{ pid: launcher.pid, identity: "start:100" }],
    listProcesses: async () => rows,
    environment: async () => ({}),
    runTokens: async (selected) =>
      new Map(
        selected.map(({ pid }) => [
          pid,
          { state: "readable", runId: tokens.get(pid) } as const,
        ]),
      ),
    processIdentities: async (selected) =>
      new Map(
        selected.map((row) => [
          row.pid,
          rows.some(({ pid }) => pid === row.pid)
            ? ({
                state: "readable",
                identity: `start:${row.pid}`,
                lifecycle: { state: "observed", lifecycle: "non-zombie" },
                relation: {
                  state: "observed",
                  parentPid: row.parentPid,
                  processGroupId: row.processGroupId,
                },
              } as const)
            : ({
                state: "absent",
                reason: "not-found-in-caller-pid-namespace",
              } as const),
        ]),
      ),
    signalGroup,
  };
  return {
    launcher,
    orphan,
    foreign,
    unrelated,
    wrapper,
    host,
    close,
    signalGroup,
    setRows: (next: ProcessTableEntry[]) => {
      rows = next;
    },
    rows: () => rows,
  };
}

it("checks and safely recovers registered runs", async () => {
  const {
    launcher,
    orphan,
    foreign,
    unrelated,
    wrapper,
    host,
    close,
    signalGroup,
    setRows,
    rows,
  } = providerRecoveryFixture();
  const cleanup = await prepareVerifierTokenCleanup(
    { run_id: "owned-run", verifier_pid: 100, parent_pid: 50 },
    host,
  );
  expect(() => cleanup.registerProviderRun("owned-run")).toThrow("its own run");
  expect(() => cleanup.registerProviderRun("")).toThrow(
    "receipt is unavailable",
  );
  await expect(cleanup.retainProviderRun("provider-run")).rejects.toThrow(
    "was not registered",
  );
  cleanup.registerProviderRun("provider-run");
  expect(() => cleanup.registerProviderRun("provider-run")).toThrow(
    "already registered",
  );
  setRows([launcher, wrapper, foreign]);
  const wrapperOnly = await cleanup.verify();
  expect(wrapperOnly.runs).toMatchObject([
    { run_id: "owned-run", result: { cleaned: false } },
    { run_id: "provider-run", result: { cleaned: true } },
  ]);
  expect(await cleanup.retryProviderCleanup(wrapperOnly)).toEqual({
    cleaned: true,
    runs: [],
  });
  expect(signalGroup).not.toHaveBeenCalled();
  setRows([launcher, orphan, foreign]);
  expect(rows().filter(({ parentPid }) => parentPid === launcher.pid)).toEqual(
    [],
  );
  expect(await cleanup.verify()).toMatchObject({
    cleaned: false,
    runs: [
      { run_id: "owned-run", result: { cleaned: true } },
      {
        run_id: "provider-run",
        result: {
          cleaned: false,
          reason: "token-owned process remained after cleanup",
        },
      },
    ],
  });
  await cleanup.retainProviderRun("provider-run");
  const verification = await cleanup.verify();
  expect(verification).toMatchObject({
    cleaned: false,
    reason: "token-owned process remained after cleanup",
  });
  const sharedGroup = { ...foreign, processGroupId: orphan.processGroupId };
  setRows([launcher, orphan, sharedGroup]);
  const ambiguous = await cleanup.retryProviderCleanup(verification);
  expect(ambiguous).toMatchObject({ cleaned: false });
  expect(signalGroup).not.toHaveBeenCalled();
  expect(cleanup.retainedProviderEvidence()).toMatchObject([
    {
      run_id: "provider-run",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          pid: orphan.pid,
          identity: "start:200",
          applicability: "token-verified",
        }),
      ]),
    },
  ]);
  // The ambiguous member exits; a different unrelated process remains live.
  setRows([launcher, orphan, unrelated]);
  const retry = await cleanup.retryProviderCleanup(ambiguous);
  expect(retry, JSON.stringify(retry)).toMatchObject({
    cleaned: true,
    runs: [
      { run_id: "provider-run", result: { cleaned: true, signaled: true } },
    ],
  });
  expect(signalGroup).toHaveBeenCalledExactlyOnceWith(
    orphan.processGroupId,
    "SIGKILL",
  );
  expect(rows()).toEqual([launcher, unrelated]);
  expect(await cleanup.verify()).toMatchObject({ cleaned: true });
  cleanup.registerProviderRun("unobserved-provider-run");
  await expect(
    cleanup.retainProviderRun("unobserved-provider-run"),
  ).rejects.toThrow("No token-verified process ownership");
  expect((await cleanup.verify()).runs).toContainEqual({
    run_id: "unobserved-provider-run",
    result: { cleaned: true, signaled: false },
  });
  await cleanup.close();
  expect(close).toHaveBeenCalledOnce();
});

it("closes the inspection host when baseline ownership cannot be established", async () => {
  const close = vi.fn();
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [],
    environment: async () => ({}),
    signalGroup: vi.fn(),
    close,
  };
  await expect(
    prepareVerifierTokenCleanup(
      { run_id: "owned-run", verifier_pid: 100, parent_pid: 50 },
      host,
    ),
  ).rejects.toThrow("baseline is unavailable");
  expect(close).toHaveBeenCalledOnce();
});

it("preserves preparation and close failures after the same host closes on retry", async () => {
  const primary = new Error("baseline inspection failed");
  const firstClose = new Error("helper root is temporarily busy");
  const close = vi.fn().mockRejectedValueOnce(firstClose);
  const host: ProcessOwnershipHost = {
    captureBaseline: vi.fn().mockRejectedValueOnce(primary),
    listProcesses: async () => [],
    environment: async () => ({}),
    signalGroup: vi.fn(),
    close,
  };
  await expect(
    prepareVerifierTokenCleanup(
      { run_id: "owned-run", verifier_pid: 100, parent_pid: 50 },
      host,
    ),
  ).rejects.toMatchObject({ cause: primary, errors: [primary, firstClose] });
  expect(close.mock.contexts).toEqual([host, host]);
});

it("preserves a retryable host and every failure after final verification", async () => {
  const primary = new Error("analysis failed");
  const sweepFailure = new Error("token sweep could not verify cleanup");
  const firstClose = new Error("helper root is still busy");
  const retryClose = new Error("helper root remained busy on retry");
  const close = vi
    .fn()
    .mockRejectedValueOnce(firstClose)
    .mockRejectedValueOnce(retryClose);
  const host: ProcessOwnershipHost = {
    captureBaseline: async () => [],
    listProcesses: async () => [
      {
        pid: 100,
        parentPid: 50,
        processGroupId: 100,
        state: "S",
        command: "verifier",
      },
    ],
    environment: async () => ({}),
    signalGroup: vi.fn(),
    close,
  };
  const cleanup = await prepareVerifierTokenCleanup(
    { run_id: "owned-run", verifier_pid: 100, parent_pid: 50 },
    host,
  );
  const failure = await withVerifierCleanup(() => {
    throw primary;
  }, [
    () => {
      throw sweepFailure;
    },
    cleanup.close,
  ]).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AggregateError);
  const aggregate = failure as AggregateError;
  expect(aggregate.cause).toBe(primary);
  expect(aggregate.errors).toEqual([
    primary,
    sweepFailure,
    expect.objectContaining({
      cause: firstClose,
      errors: [firstClose, retryClose],
      cleanupOwner: host,
    }),
  ]);
  expect(close.mock.contexts).toEqual([host, host]);
  const retainedFailure = aggregate.errors[2] as {
    cleanupOwner: ProcessOwnershipHost;
  };
  expect(retainedFailure.cleanupOwner).toBe(host);
  await retainedFailure.cleanupOwner.close?.();
  expect(close.mock.contexts).toEqual([host, host, host]);
});

// Both the fixture inspector and production launcher can compile a helper.
// Allow separate compiler discovery as well as the orphan lifecycle.
const orphanTestTimeout = Math.min(
  MAX_NODE_TIMER_DELAY_MS,
  process.platform === "darwin"
    ? 2 * resolveSwiftcCompileTimeoutMs() + 60_000
    : 20_000,
);
it.runIf(process.platform !== "win32")(
  "detects and recovers a predeclared provider orphan without prior live ownership",
  async () => {
    const run = {
      run_id: randomUUID(),
      verifier_pid: process.pid,
      parent_pid: process.ppid,
    };
    const providerRun = randomUUID();
    const host = createSystemProcessOwnershipHost();
    let orphanPid: number | undefined;
    const cleanup = await prepareVerifierTokenCleanup(run, {
      ...host,
      // Isolate the fixture's rows from unrelated host churn while retaining
      // the real baseline and native identity and token observations.
      listProcesses: async (signal) =>
        (await host.listProcesses(signal)).filter(
          ({ pid }) => pid === run.verifier_pid || pid === orphanPid,
        ),
    });
    let orphanIdentity: ProcessIdentityObservation | undefined;
    try {
      cleanup.registerProviderRun(providerRun);
      const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:'ignore',env:process.env});process.stdout.write(JSON.stringify({run_id:process.env.REA_PROCESS_RUN_ID,pid:child.pid}));child.unref();`;
      const launched = await spawnOwnedProviderProcess({
        command: process.execPath,
        arguments: ["-e", code],
        runId: providerRun,
        env: { REA_PROCESS_RUN_ID: run.run_id },
        expectedCommand: null,
      });
      let output = "";
      launched.process.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      launched.process.stderr?.resume();
      await new Promise<void>((resolve) => {
        if (launched.process.exitCode !== null) resolve();
        else launched.process.once("close", resolve);
      });
      const receipt = JSON.parse(output) as { run_id: string; pid: number };
      orphanPid = receipt.pid;
      orphanIdentity = await observeProcessStartIdentity(orphanPid, host);
      expect(receipt.run_id).toBe(providerRun);
      expect(receipt.run_id).not.toBe(run.run_id);
      expect(orphanIdentity?.state).toBe("readable");
      // No live retention: the first provider operation can fail before the
      // verifier can capture process coordinates or retain native identities.
      const result = await cleanup.verify();
      expect(result).toMatchObject({ cleaned: false });
      expect(
        result.runs.find(({ run_id }) => run_id === run.run_id)?.result,
      ).toMatchObject({ cleaned: true });
      expect(
        result.runs.find(({ run_id }) => run_id === providerRun)?.result,
      ).toMatchObject({
        cleaned: false,
        reason: "token-owned process remained after cleanup",
      });
      const row = (await host.listProcesses()).find(
        ({ pid }) => pid === orphanPid,
      );
      expect(row?.parentPid).not.toBe(process.pid);
      expect(row?.parentPid).not.toBe(launched.process.pid);
      expect(await cleanup.retryProviderCleanup(result)).toMatchObject({
        cleaned: true,
        runs: [
          { run_id: providerRun, result: { cleaned: true, signaled: true } },
        ],
      });
      if (orphanIdentity?.state !== "readable")
        throw new Error("Orphan fixture identity was unavailable");
      expect(
        await observeProcessStartIdentityExit(
          orphanPid,
          orphanIdentity.identity,
          host,
        ),
      ).toBe("exited");
      orphanPid = undefined;
    } finally {
      try {
        if (orphanPid !== undefined && orphanIdentity?.state === "readable") {
          const pid = orphanPid;
          const identity = orphanIdentity.identity;
          expect(
            await signalProcessWithStartIdentity(pid, identity, "SIGTERM", {
              host,
            }),
          ).toBe("signaled");
          await vi.waitFor(
            async () => {
              expect(
                await observeProcessStartIdentityExit(pid, identity, host),
              ).toBe("exited");
            },
            { timeout: 3000, interval: 20 },
          );
        }
      } finally {
        await cleanup.close();
      }
    }
  },
  orphanTestTimeout,
);
