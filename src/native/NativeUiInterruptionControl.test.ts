import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { expect, it } from "vitest";
import { NativeUiInterruptionControl } from "./NativeUiInterruptionControl.js";

it("reports the selected native UI deadline", () => {
  const deadline = AbortSignal.abort();
  const control = new NativeUiInterruptionControl(undefined, deadline, 2_500);
  const error = control.error("observe_native_ui");
  expect(error).toBeInstanceOf(AnalysisTimeoutError);
  if (!(error instanceof AnalysisTimeoutError)) return;
  const projected = projectAnalysisError(error);
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 2500 },
  });
  control.dispose();
});

it("gives a pre-aborted caller priority over a pre-aborted deadline", () => {
  const reason = { phase: "shared" };
  const caller = new AbortController();
  const deadline = new AbortController();
  caller.abort(reason);
  deadline.abort(reason);
  const control = new NativeUiInterruptionControl(
    caller.signal,
    deadline.signal,
  );
  expect(control.error("observe_native_ui")).toBeInstanceOf(
    AnalysisCancelledError,
  );
  expect(control.error("observe_native_ui")?.cause).toBe(reason);
  control.dispose();
});

it.each([
  ["deadline", AnalysisTimeoutError],
  ["caller", AnalysisCancelledError],
] as const)(
  "keeps a first %s interruption when the signals share a reason",
  (source, ErrorType) => {
    const reason = { phase: "shared" };
    const caller = new AbortController();
    const deadline = new AbortController();
    const control = new NativeUiInterruptionControl(
      caller.signal,
      deadline.signal,
    );
    const [first, later] =
      source === "caller" ? [caller, deadline] : [deadline, caller];
    first.abort(reason);
    later.abort(reason);
    const error = control.error("observe_native_ui");
    expect(error).toBeInstanceOf(ErrorType);
    expect(error?.cause).toBe(reason);
    control.dispose();
  },
);
