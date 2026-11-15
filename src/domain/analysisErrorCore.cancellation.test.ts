import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
  isAborted,
  OwnerCancellation,
} from "./analysisErrorCore.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";

it("takes the cause from each kind of required cancellation reason", () => {
  const callerReason = { caller: "stop" };
  const controller = new AbortController();
  controller.abort(callerReason);

  const fromSignal = cancelledBy("probe", controller.signal);
  const fromEarlier = cancelledBy("outer", fromSignal);
  const fromCarried = cancelledBy("carried", carriedReason(callerReason));
  const fromOwner = cancelledBy("closed", OwnerCancellation.ownerClosed);

  expect(fromSignal).toBeInstanceOf(AnalysisCancelledError);
  expect(fromSignal.operation).toBe("probe");
  expect(fromSignal.cause).toBe(callerReason);
  expect(fromEarlier.cause).toBe(callerReason);
  expect(fromCarried.cause).toBe(callerReason);
  expect(fromOwner.cause).toBe(OwnerCancellation.ownerClosed);
  expect(OwnerCancellation.ownerClosed.kind).toBe("owner-closed");
});

it("keeps the cancellation projection unchanged by the reason it carries", () => {
  const controller = new AbortController();
  controller.abort(new Error("caller detail"));
  const cleanup = { reason: "retained", resources: ["/tmp/owned"] };

  const fromSignal = cancelledBy("probe", controller.signal, {
    userMessage: "Stopped.",
    cleanup,
  });
  const fromOwner = cancelledBy("probe", OwnerCancellation.ownerClosed, {
    userMessage: "Stopped.",
    cleanup,
  });

  expect(projectAnalysisError(fromOwner)).toEqual(
    projectAnalysisError(fromSignal),
  );
  expect(JSON.stringify(projectAnalysisError(fromOwner))).not.toContain(
    "OwnerCancellation",
  );
});

it("narrows only an aborted signal for cancelledBy", () => {
  const controller = new AbortController();
  const optional: AbortSignal | undefined = controller.signal;
  expect(isAborted(undefined)).toBe(false);
  expect(isAborted(optional)).toBe(false);
  controller.abort("caller");
  if (!isAborted(optional)) throw new Error("Expected an aborted signal");
  expect(cancelledBy("probe", optional).cause).toBe("caller");
});

it("reads the reason of a signal that is not this realm's AbortSignal", () => {
  const reason = { caller: "foreign" };
  const foreign = { aborted: true, reason } as unknown as AbortSignal;
  expect(cancelledBy("probe", foreign).cause).toBe(reason);
});

it("does not accept a cause beside the required reason", () => {
  const controller = new AbortController();
  controller.abort("caller");
  // @ts-expect-error The reason argument owns the cause.
  const error = cancelledBy("probe", controller.signal, { cause: "other" });
  expect(error.cause).toBe("caller");
});
