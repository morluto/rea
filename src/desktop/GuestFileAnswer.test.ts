import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { readHomeFiles } from "./ComputerHomeFiles.js";
import {
  AgentEnvComputer,
  GUEST_FILE_ANSWER_COPIES,
  GUEST_FILE_ANSWER_SOURCE,
  guestFileAnswerBytes,
  guestFileAnswerRefusal,
  guestFileAnswerWorkingBytes,
  retainGuestFiles,
} from "./AgentEnvComputer.js";

describe("guest file answers", () => {
  it.each([true, false])(
    "uses only the named data-object metadata for file identity (present: %s)",
    async (present) => {
      const files = await readHomeFiles(
        async () => ({
          result: {
            parts: [
              {
                kind: "file",
                file: { bytes: Buffer.from("source bytes").toString("base64") },
                metadata: {
                  "urn:unrelated": { path: "other.txt" },
                  ...(present
                    ? {
                        "urn:agentenv:data-objects/v1": {
                          path: "selected.txt",
                        },
                      }
                    : {}),
                },
              },
            ],
          },
        }),
        (text) => text,
        ["selected.txt"],
      );
      expect(files).toEqual([
        {
          path: present ? "selected.txt" : undefined,
          bytes: Buffer.from("source bytes"),
        },
      ]);
    },
  );

  it("counts base64, the envelope, and the copies held while the answer is parsed", () => {
    expect(guestFileAnswerBytes(3, 1)).toBeGreaterThan(3);
    expect(guestFileAnswerBytes(3, 2)).toBeGreaterThan(
      guestFileAnswerBytes(3, 1),
    );
    const wire = guestFileAnswerBytes(3, 1);
    expect(guestFileAnswerRefusal(3, 1, wire)).toBeInstanceOf(
      AnalysisResourceConstraintError,
    );
    expect(
      guestFileAnswerRefusal(3, 1, wire * GUEST_FILE_ANSWER_COPIES),
    ).toBeUndefined();
    expect(guestFileAnswerWorkingBytes(wire * GUEST_FILE_ANSWER_COPIES)).toBe(
      wire,
    );
  });

  it("refuses a reported size that expands past the working budget before naming a fetch", () => {
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
      answer_working_bytes: guestFileAnswerWorkingBytes(ceiling),
      answer_copies: GUEST_FILE_ANSWER_COPIES,
      ceiling_source: GUEST_FILE_ANSWER_SOURCE,
    });
    expect(refusal.remediationAction).toContain(GUEST_FILE_ANSWER_SOURCE);
    expect(refusal.remediationAction).toContain("--max-old-space-size");
    expect(refusal.remediationAction).toContain("Restart REA");
    expect(guestFileAnswerBytes(reported, 2)).toBeGreaterThan(
      guestFileAnswerWorkingBytes(ceiling),
    );
  });

  it("does not keep file bytes the computer reported as smaller", () => {
    const retained = retainGuestFiles(
      [{ path: "out.json", bytes: Buffer.from("larger") }],
      1,
      1,
      1_000_000,
    );
    expect(retained.ok).toBe(false);
    if (retained.ok) return;
    expect(retained.error.reportedLimits).toMatchObject({
      guest_file_bytes: 1,
      decoded_file_bytes: Buffer.from("larger").length,
    });
  });

  it("does not ask the computer for a home file past that same ceiling", async () => {
    const failure = await AgentEnvComputer.prototype.homeFiles
      .call({}, ["out.json"], Number.MAX_SAFE_INTEGER)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisResourceConstraintError);
  });
});
