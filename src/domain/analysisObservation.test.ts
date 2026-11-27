import { describe, expect, it } from "vitest";

import {
  analysisExecutionEnvelopeForAdmission,
  createAnalysisExecutionEvidence,
  type AnalysisObservation,
} from "./analysisObservation.js";

const execution = (
  overrides: Partial<AnalysisObservation> = {},
): AnalysisObservation => ({
  result: { stop_reason: "returned" },
  rawResult: null,
  provider: { id: "unicorn", name: "Unicorn Engine", version: "2.1.2" },
  limitations: [],
  locations: [],
  ...overrides,
});

const ENVIRONMENT = {
  id: "unicorn-2.1.2",
  platform: "linux",
  architecture: "x86_64",
  isolation: "process" as const,
};

describe("createAnalysisExecutionEvidence", () => {
  it("preserves the execution environment in committed Evidence", () => {
    // Greptile 2026-11-24 P1: the environment was passed to
    // EvidenceCreationOptions, which never reads it, so the committed
    // Evidence lost the execution environment.
    const evidence = createAnalysisExecutionEvidence(
      "emulate_function",
      {},
      execution({ environment: ENVIRONMENT }),
      "observed",
    );
    expect(evidence.environment).toEqual(ENVIRONMENT);
  });

  it("carries the execution environment in the admission envelope", () => {
    const envelope = analysisExecutionEnvelopeForAdmission(
      "emulate_function",
      {},
      execution({ environment: ENVIRONMENT }),
    );
    expect(envelope.environment).toEqual(ENVIRONMENT);
  });

  it("does not carry subjectUnavailableReason onto Evidence", () => {
    // Evidence has no subjectUnavailableReason field: the reason stays
    // on the in-memory observation, and passing it through the creation
    // options only dropped it silently.
    const evidence = createAnalysisExecutionEvidence(
      "emulate_function",
      {},
      execution({
        environment: ENVIRONMENT,
        subject: null,
        subjectUnavailableReason:
          "Target-free Unicorn run: function bytes are caller-supplied, not an opened artifact.",
      }),
      "observed",
    );
    expect(evidence.environment).toEqual(ENVIRONMENT);
    expect("subjectUnavailableReason" in evidence).toBe(false);
  });

  it("leaves the environment null when the execution claims none", () => {
    const evidence = createAnalysisExecutionEvidence(
      "emulate_function",
      {},
      execution(),
      "observed",
    );
    expect(evidence.environment).toBeNull();
  });
});
