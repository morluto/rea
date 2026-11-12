import { expect, it } from "vitest";

import {
  HOPPER_APPLE_EVENTS_DENIAL_REMEDIATION,
  hopperAppleEventsDenial,
  HopperCancelledError,
} from "./hopperErrors.js";
import { analysisErrorRemediationAction } from "./analysisErrorPresentation.js";

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
  // The reporter saw `retryable: true` with "Allow the application that starts REA under
  // System Settings > Privacy & Security > Automation": a hardened client without
  // com.apple.security.automation.apple-events is never prompted and never listed there.
  const error = hopperAppleEventsDenial();
  const remediation = analysisErrorRemediationAction(error, "continuing");
  expect(remediation).toBe(HOPPER_APPLE_EVENTS_DENIAL_REMEDIATION);
  expect(remediation).not.toContain("then retry opening the target");
  // The two recoveries that work, without needing the client's bundle identity.
  expect(remediation).toContain("com.apple.security.automation.apple-events");
  expect(remediation).toContain("Start REA from a client macOS can authorize");
  expect(error._tag).toBe("HopperStartError");
});

it("keeps the denial message free of the instruction it cannot support", () => {
  const error = hopperAppleEventsDenial();
  expect(error.userMessage).toBe(
    "macOS denied permission to send Apple Events to Hopper.",
  );
  expect(error.userMessage).not.toContain("Automation");
});
