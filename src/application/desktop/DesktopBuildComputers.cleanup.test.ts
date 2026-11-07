import { expect, it, vi } from "vitest";
import { AgentEnvComputer } from "../../desktop/AgentEnvComputer.js";
import { ComputerHelper } from "../../desktop/AgentEnvComputerHelper.js";
import { ScreenJudgeProcess } from "../../desktop/ScreenJudgeProcess.js";
import { DesktopBuildComputers } from "./DesktopBuildComputers.js";

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
