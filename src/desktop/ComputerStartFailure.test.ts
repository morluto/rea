import { describe, expect, it } from "vitest";

import {
  ComputerStartFailure,
  computerFailedOnReadiness,
} from "./AgentEnvComputer.js";

describe("computerFailedOnReadiness", () => {
  it("reads the readiness fact, including a final check whose message never says not ready", () => {
    const failed = new ComputerStartFailure(
      "The computer's app check failed: no detail.",
      "Read the helper's output.",
      { reason: "not_ready" },
    );
    const wording = new ComputerStartFailure(
      "it didn't boot: the computer wasn't ready",
      undefined,
      { reason: "handshake" },
    );

    expect(computerFailedOnReadiness(failed)).toBe(true);
    expect(computerFailedOnReadiness(wording)).toBe(false);
    expect(computerFailedOnReadiness(new Error("not ready"))).toBe(false);
  });
});
