import { expect, it } from "vitest";

import {
  createAnalysisExecutionEvidence,
  type AnalysisObservation,
} from "./analysisObservation.js";
import { isImmutableEvidence } from "./evidence.js";

it("preserves selected Evidence authority alongside immutable snapshot ownership", () => {
  const observation: AnalysisObservation = {
    result: { entries: ["observed"] },
    rawResult: null,
    provider: { id: "fixture", name: "Fixture", version: "1" },
    limitations: [],
    locations: [],
  };
  const evidence = createAnalysisExecutionEvidence(
    "perform_adb_ui_action",
    { serial: "selected-device" },
    observation,
    "observed",
    { authority: "controlled-replay", immutable: true },
  );

  expect(evidence).toMatchObject({
    authority: "controlled-replay",
    parameters: { serial: "selected-device" },
    normalized_result: { entries: ["observed"] },
  });
  expect(isImmutableEvidence(evidence)).toBe(true);
  expect(Object.isFrozen(evidence.normalized_result)).toBe(true);
  expect(
    createAnalysisExecutionEvidence("inspect", {}, observation, "observed", {
      immutable: true,
    }).authority,
  ).toBe("shipped-artifact");
});
