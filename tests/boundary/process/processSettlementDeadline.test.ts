import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { observeSettlement } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { observeOwnedProcessGroups } from "../../../src/process/ProcessOwnershipObservation.js";

/** Process group id that cannot exist on any supported host. */
const ABSENT_GROUP_ID = 4_294_967_295;

const observeGroup = async (groupId: number) =>
  observeOwnedProcessGroups("settlement-deadline-probe", [groupId]);

describe("settlement deadline classification", () => {
  it("does not report a single empty observation as alive_at_deadline", async () => {
    expect(
      (await observeGroup(ABSENT_GROUP_ID)).get(ABSENT_GROUP_ID)?.state,
    ).toBe("empty");

    const settlement = await observeSettlement(
      "settlement-single-empty",
      [ABSENT_GROUP_ID],
      0,
      () => undefined,
      "linux",
    );
    expect(settlement.state).toBe("unverifiable");
  });

  it("still reports observed liveness as alive_at_deadline", async () => {
    const runId = "settlement-live-group";
    // A detached child leads its own process group and carries the run token,
    // so the group observes as a genuinely owned live member.
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, REA_PROCESS_RUN_ID: runId },
    });
    child.unref();
    try {
      // Wait until the child is actually listed before asserting on it.
      const started = Date.now();
      while (
        (await observeOwnedProcessGroups(runId, [child.pid!])).get(child.pid!)
          ?.state !== "alive"
      ) {
        if (Date.now() - started > 5_000)
          throw new Error("live fixture group never observed as alive");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const settlement = await observeSettlement(
        runId,
        [child.pid!],
        0,
        () => undefined,
        "linux",
      );
      expect(settlement.state).toBe("alive_at_deadline");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("still reports two consecutive empty observations as quiesced", async () => {
    const settlement = await observeSettlement(
      "settlement-two-empty",
      [ABSENT_GROUP_ID],
      1_000,
      () => undefined,
      "linux",
    );
    expect(settlement.state).toBe("quiesced");
  });
});
