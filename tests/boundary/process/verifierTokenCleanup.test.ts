import { randomUUID } from "node:crypto";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import {
  createSystemProcessOwnershipHost,
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
  signalProcessWithStartIdentity,
} from "../../../src/process/ProcessOwnershipObservation.js";
import { expect, it, vi } from "vitest";
import { prepareVerifierTokenCleanup } from "../../../scripts/lib/verifier-token-cleanup.mjs";
import type {
  ProcessOwnershipHost,
  ProcessIdentityObservation,
  ProcessTableEntry,
} from "../../../src/process/ProcessOwnership.js";

it("checks registered runs before and after live ownership is retained", async () => {
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
  const tokens = new Map([
    [orphan.pid, "provider-run"],
    [foreign.pid, "foreign-run"],
    [wrapper.pid, "owned-run"],
  ]);
  let rows = [launcher];
  const close = vi.fn();
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
    signalGroup: vi.fn(),
  };
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
  rows = [launcher, wrapper, foreign];
  expect((await cleanup.verify()).runs).toMatchObject([
    { run_id: "owned-run", result: { cleaned: false } },
    { run_id: "provider-run", result: { cleaned: true } },
  ]);
  rows = [launcher, orphan, foreign];
  expect(rows.filter(({ parentPid }) => parentPid === launcher.pid)).toEqual(
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
  expect(await cleanup.verify()).toMatchObject({
    cleaned: false,
    reason: "token-owned process remained after cleanup",
  });
  rows = [launcher, foreign];
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
  expect(host.signalGroup).not.toHaveBeenCalled();
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

it.runIf(process.platform !== "win32")(
  "detects a predeclared provider orphan without capturing live ownership",
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
  20000,
);
