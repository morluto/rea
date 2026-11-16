import { describe, expect, it } from "vitest";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { UnclassifiedProviderFailure } from "../domain/unclassifiedProviderFailure.js";
import {
  classifyProviderOutcome,
  type ProviderDialectOutcome,
  type ProviderOutcomeContext,
} from "./classifyProviderOutcome.js";
import type { ProviderProcessSnapshot } from "./ProviderProcess.js";

const snapshot: ProviderProcessSnapshot = {
  stdout: { text: "", bytes: 0, observedBytes: 0 },
  stderr: { text: "unrecognised diagnostic", bytes: 23, observedBytes: 23 },
  exitCode: 3,
  signal: null,
};

const context = (
  dialect: ProviderOutcomeContext["dialect"],
): ProviderOutcomeContext => ({
  providerId: "example",
  operation: "inspect_target",
  capturedOutput: (retained) => ({
    stdout: retained.stdout.text,
    stderr: retained.stderr.text,
    truncated: false,
  }),
  timeout: { ms: 1000 },
  outputLimit: { limits: null, recovery: {} },
  dialect,
});

/** A dialect that recognises nothing and reports its phase. */
const unrecognised = context((_outcome, _details, unclassified) =>
  unclassified({ diagnostics: { phase: "worker" } }),
);

describe("an outcome the provider dialect does not recognise", () => {
  const cases: readonly {
    readonly name: string;
    readonly outcome: ProviderDialectOutcome;
    readonly examined: Record<string, unknown>;
  }[] = [
    {
      name: "an exit",
      outcome: {
        kind: "exited",
        cause: new Error("exited with 3"),
        message: "exited with 3",
        output: { snapshot, truncated: true },
        exitCode: 3,
        signal: null,
        stopRequested: false,
      },
      examined: {
        failure_kind: "exited",
        reason: "exited with 3",
        exit_code: 3,
        signal: null,
        stop_requested: false,
        output_truncated: true,
      },
    },
    {
      name: "a stream failure keeping the recorded status",
      outcome: {
        kind: "protocol",
        cause: new Error("stdout stream failed"),
        message: "stdout stream failed",
        output: { snapshot, truncated: false },
      },
      examined: {
        failure_kind: "protocol",
        exit_code: 3,
        signal: null,
        output_truncated: false,
      },
    },
  ];
  it.each(cases)(
    "reports $name with the examined outcome",
    ({ outcome, examined }) => {
      const failure = classifyProviderOutcome(outcome, unrecognised);
      expect(failure).toBeInstanceOf(UnclassifiedProviderFailure);
      expect(failure).toMatchObject({
        _tag: "ProviderAdapterError",
        providerId: "example",
        operation: "inspect_target",
        examined,
        diagnostics: { phase: "worker", ...examined },
        cause: outcome.cause,
      });
      expect(projectAnalysisError(failure)).toMatchObject({
        code: "execution_failure",
        details: { diagnostics: { phase: "worker", ...examined } },
      });
    },
  );

  it("keeps the retained output beside the examined outcome by default", () => {
    const failure = classifyProviderOutcome(
      {
        kind: "exited",
        cause: new Error("exited with 3"),
        message: "exited with 3",
        output: { snapshot, truncated: false },
        exitCode: 3,
        signal: null,
        stopRequested: true,
      },
      context((_outcome, _details, unclassified) => unclassified()),
    );
    expect(failure.capturedOutput).toMatchObject({
      stderr: "unrecognised diagnostic",
    });
    expect(failure.diagnostics).toMatchObject({ stop_requested: true });
  });

  it("adds the provider's diagnostics to the context's diagnostics", () => {
    const failure = classifyProviderOutcome(
      {
        kind: "exited",
        cause: new Error("exited with 3"),
        message: "exited with 3",
        output: { snapshot, truncated: false },
        exitCode: 3,
        signal: null,
        stopRequested: false,
      },
      {
        ...context((_outcome, _details, unclassified) =>
          unclassified({ diagnostics: { phase: "worker" } }),
        ),
        details: { diagnostics: { receipt: "finalization failed" } },
      },
    );
    expect(failure.diagnostics).toMatchObject({
      receipt: "finalization failed",
      phase: "worker",
      failure_kind: "exited",
    });
  });

  it("does not report an outcome the dialect classified", () => {
    const failure = classifyProviderOutcome(
      {
        kind: "exited",
        cause: new Error("exited with 3"),
        message: "exited with 3",
        output: { snapshot, truncated: false },
        exitCode: 3,
        signal: null,
        stopRequested: false,
      },
      context(
        (outcome, details) =>
          new AnalysisOutputError("inspect_target", outcome.message, details),
      ),
    );
    expect(failure).toBeInstanceOf(AnalysisOutputError);
    expect(failure.diagnostics).toBeUndefined();
  });
});
