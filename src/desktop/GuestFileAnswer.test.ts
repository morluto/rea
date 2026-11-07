import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  AgentEnvComputer,
  GUEST_FILE_ANSWER_SOURCE,
  guestFileAnswerBytes,
  guestFileAnswerCeiling,
  guestFileAnswerRefusal,
} from "./AgentEnvComputer.js";

describe("guest file answers", () => {
  it("counts base64 and the envelope, and admits a file that fits the ceiling", () => {
    expect(guestFileAnswerBytes(3, 1)).toBeGreaterThan(3);
    expect(guestFileAnswerBytes(3, 2)).toBeGreaterThan(
      guestFileAnswerBytes(3, 1),
    );
    const ceiling = guestFileAnswerBytes(3, 1);
    expect(guestFileAnswerRefusal(3, 1, ceiling)).toBeUndefined();
  });

  it("refuses a reported size that expands past the host ceiling before naming a fetch", () => {
    const ceiling = 1000;
    const reported = 3000;
    const refusal = guestFileAnswerRefusal(reported, 2, ceiling);
    expect(refusal).toBeInstanceOf(AnalysisResourceConstraintError);
    if (refusal === undefined) return;
    expect(refusal.reportedLimits).toEqual({
      guest_file_bytes: reported,
      file_count: 2,
      answer_bytes: guestFileAnswerBytes(reported, 2),
      answer_ceiling_bytes: ceiling,
      ceiling_source: GUEST_FILE_ANSWER_SOURCE,
    });
    expect(refusal.remediationAction).toContain(GUEST_FILE_ANSWER_SOURCE);
    expect(refusal.remediationAction).toContain("--max-old-space-size");
    expect(refusal.remediationAction).toContain("Restart REA");
    expect(guestFileAnswerBytes(reported, 2)).toBeGreaterThan(ceiling);
  });

  it("does not ask the computer for a home file past that same ceiling", async () => {
    const failure = await AgentEnvComputer.prototype.homeFiles
      .call({}, ["out.json"], Number.MAX_SAFE_INTEGER)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisResourceConstraintError);
  });
});
