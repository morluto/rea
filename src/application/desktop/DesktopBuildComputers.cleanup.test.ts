import { expect, it, vi } from "vitest";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { request } from "../../domain/desktop/appBuild.fixture.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import {
  AgentEnvComputer,
  ComputerStartFailure,
} from "../../desktop/AgentEnvComputer.js";
import { ComputerHelper } from "../../desktop/AgentEnvComputerHelper.js";
import { ScreenJudgeProcess } from "../../desktop/ScreenJudgeProcess.js";
import { BuildComputerLongRuns } from "../../desktop/BuildComputerLongRuns.js";
import { DesktopBuildComputers } from "./DesktopBuildComputers.js";
import { DesktopRemoteTaskReaders } from "./DesktopRemoteTaskReaders.js";

it("resolves the original failed start's cleanup after its retained computer closes", async () => {
  const release = vi
    .fn()
    .mockResolvedValueOnce({
      verified: false,
      reason: "container busy",
      resources: ["sandbox"],
    })
    .mockResolvedValue({ verified: true, teardown: "agentenv" });
  const spawn = vi.spyOn(ComputerHelper, "spawn").mockResolvedValue({
    release,
    output: () => undefined,
  } as never);
  const connect = vi
    .spyOn(AgentEnvComputer, "connect")
    .mockRejectedValue(new Error("readiness failed"));
  const computers = new DesktopBuildComputers({
    REA_AGENT_ENV_COMMAND: "/runner",
    REA_DOCKER_COMMAND: "/docker",
  });
  try {
    const started = await computers.start(
      { source: { kind: "bundle", path: "/bundle" } },
      new AbortController().signal,
    );
    if (started.ok) throw new Error("Expected failed start");
    const id = started.error.diagnostics?.computer_id;
    if (typeof id !== "string")
      throw new Error("Expected retained computer id");
    expect(started.error.cleanupIncomplete).toBe(true);
    expect(started.error.cleanupResources).toEqual(["sandbox"]);
    expect((await computers.close(id)).ok).toBe(true);
    expect(started.error.cleanupIncomplete).toBe(false);
    expect(started.error.cleanupResources).toEqual([]);
    expect(started.error.userMessage).toBe("readiness failed");
  } finally {
    await computers.closeAll();
    spawn.mockRestore();
    connect.mockRestore();
  }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "preserves a readiness failure while reporting that seed locks could not be checked",
  async () => {
    const bundle = await createTestTempDirectory("rea-unreadable-build-seed-");
    const envs = join(bundle, "envs");
    await mkdir(envs);
    await chmod(envs, 0);
    const original = new ComputerStartFailure(
      "Application readiness failed",
      "Repair the app",
      { reason: "not_ready" },
    );
    const spawn = vi.spyOn(ComputerHelper, "spawn").mockResolvedValue({
      release: async () => ({ verified: true, teardown: "agentenv" }),
      output: () => undefined,
    } as never);
    const connect = vi
      .spyOn(AgentEnvComputer, "connect")
      .mockRejectedValue(original);
    const computers = new DesktopBuildComputers({
      REA_AGENT_ENV_COMMAND: "/runner",
      REA_DOCKER_COMMAND: "/docker",
    });
    try {
      const started = await computers.start(
        { source: { kind: "bundle", path: bundle } },
        new AbortController().signal,
      );
      expect(started.ok).toBe(false);
      if (started.ok) throw new Error("Expected readiness failure");
      expect(started.error.userMessage).toContain(original.message);
      expect(started.error.userMessage).toContain("could not check");
      expect(started.error.cause).toMatchObject({
        reason: "not_ready",
        cause: original,
      });
    } finally {
      await chmod(envs, 0o700);
      await computers.closeAll();
      spawn.mockRestore();
      connect.mockRestore();
    }
  },
);

it("retains a failed bundle workspace and its write error until shutdown retries cleanup", async () => {
  const folder = await createTestTempDirectory("rea-build-bundle-cleanup-");
  const payload = join(folder, "payload.tar");
  await writeFile(payload, "controlled payload");
  const create = PrivateRuntimeRoot.create.bind(PrivateRuntimeRoot);
  let workspace: PrivateRuntimeRoot | undefined;
  const created = vi
    .spyOn(PrivateRuntimeRoot, "create")
    .mockImplementation(async (options) => {
      workspace = await create(options);
      await writeFile(join(workspace.path, "bundle"), "blocks bundle creation");
      vi.spyOn(workspace, "close").mockRejectedValueOnce(
        new Error("workspace removal failed"),
      );
      return workspace;
    });
  const computers = new DesktopBuildComputers({
    REA_AGENT_ENV_COMMAND: "/runner",
    REA_DOCKER_COMMAND: "/docker",
    REA_BUILD_COMPUTER_REA_ARCHIVE: payload,
  });
  try {
    const started = await computers.start(
      {
        source: request({
          kind: "archive",
          package: "mousepad",
          extra_packages: [],
        }),
      },
      new AbortController().signal,
    );
    expect(started.ok).toBe(false);
    if (started.ok || workspace === undefined)
      throw new Error("Expected bundle creation failure");
    expect(started.error.userMessage).toContain("ENOTDIR");
    expect(started.error.cleanup?.reason).toContain("workspace removal failed");
    expect(started.error.cleanupResources).toEqual([workspace.path]);
    await expect(access(workspace.path)).resolves.toBeUndefined();
    await computers.closeAll();
    await expect(access(workspace.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(started.error.cleanupIncomplete).toBe(false);
  } finally {
    created.mockRestore();
    await computers.closeAll().catch(() => computers.closeAll());
    await workspace?.close();
  }
});

it.each([false, true])(
  "releases the computer even if judge cleanup fails (computer also fails: %s)",
  async (computerFails) => {
    const computerClose = vi
      .fn()
      .mockResolvedValueOnce(
        computerFails
          ? {
              verified: false,
              reason: "computer failed",
              resources: ["sandbox"],
            }
          : { verified: true, teardown: "agentenv" },
      )
      .mockResolvedValue({ verified: true, teardown: "agentenv" });
    const judgeClose = vi
      .spyOn(ScreenJudgeProcess.prototype, "close")
      .mockResolvedValueOnce({
        verified: false,
        reason: "judge failed",
        resources: ["judge"],
      })
      .mockResolvedValue({ verified: true, teardown: "agentenv" });
    if (computerFails)
      judgeClose.mockResolvedValueOnce({
        verified: false,
        reason: "judge still failed",
        resources: ["judge"],
      });
    const spawn = vi
      .spyOn(ComputerHelper, "spawn")
      .mockResolvedValue({} as never);
    const connect = vi.spyOn(AgentEnvComputer, "connect").mockResolvedValue({
      computer: { close: computerClose, sandboxId: "sandbox" },
      frame: { structured: null, content: [] },
    } as never);
    const computers = new DesktopBuildComputers({
      REA_AGENT_ENV_COMMAND: "/runner",
      REA_DOCKER_COMMAND: "/docker",
    });
    try {
      const started = await computers.start(
        { source: { kind: "bundle", path: "/bundle" } },
        new AbortController().signal,
      );
      if (!started.ok) throw started.error;
      const id = started.value.value.computer_id;
      const first = await computers.close(id);
      expect(first.ok).toBe(false);
      if (first.ok) throw new Error("Expected incomplete cleanup");
      expect(first.error.cleanupResources).toEqual(
        expect.arrayContaining(
          computerFails ? ["judge", "sandbox"] : ["judge"],
        ),
      );
      expect(computerClose).toHaveBeenCalledTimes(1);
      const second = await computers.close(id);
      if (computerFails) {
        expect(second.ok).toBe(false);
        expect(first.error.cleanupResources).toEqual(["judge"]);
        expect(first.error.cleanupIncomplete).toBe(true);
        expect((await computers.close(id)).ok).toBe(true);
      } else expect(second.ok).toBe(true);
      expect(first.error.cleanupIncomplete).toBe(false);
      expect(first.error.cleanupResources).toEqual([]);
      expect(computerClose).toHaveBeenCalledTimes(computerFails ? 2 : 1);
      expect(judgeClose).toHaveBeenCalledTimes(computerFails ? 3 : 2);
    } finally {
      await computers.closeAll().catch(() => computers.closeAll());
      spawn.mockRestore();
      connect.mockRestore();
      judgeClose.mockRestore();
    }
  },
);

it("retains the computer while command and reader cleanup fail, but still releases the judge", async () => {
  const computerClose = vi
    .fn()
    .mockResolvedValue({ verified: true, teardown: "agentenv" });
  const commands = vi
    .spyOn(BuildComputerLongRuns.prototype, "release")
    .mockResolvedValueOnce({
      verified: false,
      reason: "command failed",
      resources: ["job"],
    })
    .mockResolvedValue({ verified: true, teardown: "agentenv" });
  const readers = vi
    .spyOn(DesktopRemoteTaskReaders.prototype, "release")
    .mockResolvedValueOnce({
      verified: false,
      reason: "reader failed",
      resources: ["reader"],
    })
    .mockResolvedValue({ verified: true, teardown: "agentenv" });
  const judge = vi
    .spyOn(ScreenJudgeProcess.prototype, "close")
    .mockResolvedValueOnce({
      verified: false,
      reason: "judge failed",
      resources: ["judge"],
    })
    .mockResolvedValue({ verified: true, teardown: "agentenv" });
  const spawn = vi
    .spyOn(ComputerHelper, "spawn")
    .mockResolvedValue({} as never);
  const connect = vi.spyOn(AgentEnvComputer, "connect").mockResolvedValue({
    computer: { close: computerClose, sandboxId: "sandbox" },
    frame: { structured: null, content: [] },
  } as never);
  const computers = new DesktopBuildComputers({
    REA_AGENT_ENV_COMMAND: "/runner",
    REA_DOCKER_COMMAND: "/docker",
  });
  try {
    const started = await computers.start(
      { source: { kind: "bundle", path: "/bundle" } },
      new AbortController().signal,
    );
    if (!started.ok) throw started.error;
    const id = started.value.value.computer_id;
    const first = await computers.close(id);
    if (first.ok) throw new Error("expected incomplete cleanup");
    expect(first.error.cleanupResources).toEqual(
      expect.arrayContaining(["job", "reader", "judge"]),
    );
    expect(computerClose).not.toHaveBeenCalled();
    expect(judge).toHaveBeenCalledTimes(1);
    expect((await computers.close(id)).ok).toBe(true);
    expect(first.error.cleanupIncomplete).toBe(false);
    expect(computerClose).toHaveBeenCalledTimes(1);
  } finally {
    await computers.closeAll().catch(() => computers.closeAll());
    commands.mockRestore();
    readers.mockRestore();
    judge.mockRestore();
    spawn.mockRestore();
    connect.mockRestore();
  }
});
