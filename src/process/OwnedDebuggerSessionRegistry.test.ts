import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { cancelledWithCallerReason } from "./OwnedDebuggerSessionRegistry.js";

it("preserves the caller's reason while a retained cancellation waits for release", () => {
  const reason = new Error("caller stopped waiting");
  const previous = new AnalysisCancelledError("start", {
    cleanup: {
      reason: "session still closing",
      resources: ["session"],
    },
  });
  const claim = { cleanupReleased: false };
  previous.bindCleanupReleaseClaim(claim);
  const current = cancelledWithCallerReason(
    "close",
    AbortSignal.abort(reason),
    previous,
  );
  expect(current.cause).toBe(reason);
  expect(current.cleanupPrimary).toBe(previous);
  expect(current.cleanupIncomplete).toBe(true);
  expect(current.cleanupResources).toEqual(["session"]);
  claim.cleanupReleased = true;
  expect(current.cleanupIncomplete).toBe(false);
  expect(
    cancelledWithCallerReason("close", AbortSignal.abort(reason))
      .cleanupIncomplete,
  ).toBe(false);
});
