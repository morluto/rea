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

it("rejects a token-owned survivor after it is reparented outside the verifier tree", async () => {
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
  let rows = [launcher];
  const close = vi.fn();
  const host: ProcessOwnershipHost = {
    platform: "linux",
    prepare: vi.fn(),
    close,
    captureBaseline: async () => [{ pid: launcher.pid, identity: "start:100" }],
    listProcesses: async () => rows,
    environment: async (pid) =>
      pid === orphan.pid ? { REA_PROCESS_RUN_ID: "provider-run" } : {},
    runTokens: async (selected) =>
      new Map(
        selected.map(({ pid }) => [
          pid,
          {
            state: "readable",
            runId:
              pid === orphan.pid
                ? "provider-run"
                : pid === foreign.pid
                  ? "foreign-run"
                  : undefined,
          } as const,
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
  await expect(cleanup.retainProviderRun("owned-run")).rejects.toThrow(
    "its own run",
  );
  await expect(cleanup.retainProviderRun("")).rejects.toThrow(
    "receipt is unavailable",
  );
  rows = [launcher, orphan, foreign];
  expect(rows.filter(({ parentPid }) => parentPid === launcher.pid)).toEqual(
    [],
  );
  // The old outer-token-only sweep misses the real provider token.
  expect(await cleanup.verify()).toMatchObject({ cleaned: true });
  await cleanup.retainProviderRun("provider-run");
  expect(await cleanup.verify()).toMatchObject({
    cleaned: false,
    reason: "token-owned process remained after cleanup",
  });
  rows = [launcher, foreign];
  expect(await cleanup.verify()).toMatchObject({ cleaned: true });
  await expect(
    cleanup.retainProviderRun("unobserved-provider-run"),
  ).rejects.toThrow("No token-verified process ownership");
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
  "retains the token installed by the production provider launcher after its parent exits",
  async () => {
    const run = {
      run_id: randomUUID(),
      verifier_pid: process.pid,
      parent_pid: process.ppid,
    };
    const providerRun = randomUUID();
    const host = createSystemProcessOwnershipHost();
    const cleanup = await prepareVerifierTokenCleanup(run, host);
    let orphanPid: number | undefined;
    let orphanIdentity: ProcessIdentityObservation | undefined;
    try {
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
      // This is the original false green: the wrapper token is absent, but
      // the reparented provider process still owns its distinct native token.
      expect(await cleanup.verify()).toMatchObject({ cleaned: true });
      await cleanup.retainProviderRun(receipt.run_id, {
        leaderPid: launched.ownership.leaderPid,
        processGroupId: launched.ownership.processGroupId,
      });
      const result = await cleanup.verify();
      expect(result).toMatchObject({ cleaned: false });
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
