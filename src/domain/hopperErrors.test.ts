import { expect, it } from "vitest";

import {
  HOPPER_APPLE_EVENTS_DENIAL_REMEDIATION,
  hopperAppleEventsDenial,
  HopperCancelledError,
} from "./hopperErrors.js";
import {
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
} from "./analysisErrorPresentation.js";

it("omits a cause when the caller does not supply one", () => {
  const error = new HopperCancelledError();

  expect(error._tag).toBe("HopperCancelledError");
  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, "cause")).toBe(false);
});

it("retains an explicitly undefined cause separately from omission", () => {
  const error = new HopperCancelledError(undefined, {
    diagnostics: { stage: "queue" },
  });

  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, "cause")).toBe(true);
  expect(error.diagnostics).toEqual({ stage: "queue" });
});

it("retains an opaque caller reason by identity", () => {
  const reason = { source: "caller", opaque: 7 };
  const error = new HopperCancelledError(reason);

  expect(error.cause).toBe(reason);
});

it("replaces the launch retry advice with an Apple Events recovery a client can act on", () => {
  const error = hopperAppleEventsDenial();
  expect(error._tag).toBe("HopperStartError");
  for (const lifetime of ["continuing", "invocation"] as const)
    expect(analysisErrorRemediationAction(error, lifetime)).toBe(
      HOPPER_APPLE_EVENTS_DENIAL_REMEDIATION,
    );
  expect(analysisErrorRemediationAction(error, "invocation")).not.toContain(
    "then retry opening the target",
  );
});

it("names both causes, because one launcher signature covers them", () => {
  // `nativeHopperLaunchWasDenied` matches the vendor's -1743 text, which the launcher emits both
  // when the user denied Hopper under Automation and when the responsible app never had the
  // entitlement and was therefore never prompted. Asserting only one cause would be wrong for the
  // other, so the recovery is conditional and names the pane as well as the entitlement.
  const error = hopperAppleEventsDenial();
  const message = analysisErrorUserMessage(error, "invocation");
  expect(message).toContain("Automation");
  expect(message).toContain("com.apple.security.automation.apple-events");
  expect(message).toContain("start REA from a client macOS can authorize");
  expect(message).toContain("never prompted");
});

it("reaches a one-shot invocation caller, which ignores continuing guidance", () => {
  const error = hopperAppleEventsDenial();
  // `finishAnalysisCommand` projects with the invocation lifetime, where
  // `analysisErrorRemediationAction` skips `continuingCallerGuidance`.
  expect(error.continuingCallerGuidance).toBeUndefined();
  expect(analysisErrorRemediationAction(error, "invocation")).toBe(
    HOPPER_APPLE_EVENTS_DENIAL_REMEDIATION,
  );
  expect(analysisErrorUserMessage(error, "invocation")).toContain("Automation");
});
