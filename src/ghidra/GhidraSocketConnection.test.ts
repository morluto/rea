import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  GHIDRA_STARTUP_DEADLINE_ELAPSED,
  bindGhidraSessionFailure,
} from "./GhidraSessionError.js";
import { connectGhidraSocket } from "./GhidraSocketConnection.js";

it("captures the live elapsed time in the real startup-deadline timeout", async () => {
  const timeoutMs = 60;
  const deadline = new ProviderStartupDeadline(timeoutMs);
  try {
    const result = await connectGhidraSocket({
      endpoint: {
        transport: "unix-socket",
        path: join(
          tmpdir(),
          `rea-ghidra-socket-timeout-${process.pid}`,
          "bridge.sock",
        ),
      },
      resourceScope: new ArtifactResourceScope(),
      deadline,
      failure: bindGhidraSessionFailure(() => ({})),
      isClosed: () => false,
      processExited: () => false,
      startupTimeoutMs: timeoutMs,
      handlers: { data: () => {}, error: () => {}, close: () => {} },
    });
    if (result.ok) throw new Error("Expected a Ghidra startup timeout");
    expect(result.error).toMatchObject({
      kind: "timeout",
      message: GHIDRA_STARTUP_DEADLINE_ELAPSED,
      timeoutMs,
    });
    // The value must come from the live deadline at the failure construction
    // site, so it can never report less than the exhausted budget.
    expect(result.error.elapsedMs).toBeGreaterThanOrEqual(timeoutMs);
  } finally {
    deadline.dispose();
  }
});
