import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { readHomeFiles } from "./ComputerHomeFiles.js";
import {
  AgentEnvComputer,
  guestFileAnswerBytes,
  guestFileAnswerRefusal,
  guestFileAnswerWorkingBytes,
} from "./AgentEnvComputer.js";

describe("guest file encoding", () => {
  const read = (encoded: string) =>
    readHomeFiles(
      async () => ({
        result: {
          parts: [
            {
              file: { bytes: encoded },
              metadata: {
                "urn:agentenv:data-objects/v1": { path: "selected.bin" },
              },
            },
          ],
        },
      }),
      (text) => text,
      ["selected.bin"],
    );

  it.each(["!!!", "aGVsbG8=garbage", "aGVsbG8", "Zh==", "AA-_"])(
    "rejects malformed base64 %j before retaining file bytes",
    async (encoded) => {
      await expect(read(encoded)).rejects.toThrow(
        "Expected canonical padded base64",
      );
    },
  );

  it.each([
    Buffer.alloc(0),
    Buffer.from("hello"),
    Buffer.from([0, 255, 128, 0]),
  ])("preserves valid empty, text and binary files: %j", async (bytes) => {
    await expect(read(bytes.toString("base64"))).resolves.toEqual([
      { path: "selected.bin", bytes },
    ]);
  });
});

describe("guest data-object metadata", () => {
  it.each([null, 42, { path: 42 }])(
    "refuses malformed known-namespace facts: %j",
    async (metadata) => {
      await expect(
        readHomeFiles(
          async () => ({
            result: {
              parts: [
                {
                  file: { bytes: "aGVsbG8=" },
                  metadata: { "urn:agentenv:data-objects/v1": metadata },
                },
              ],
            },
          }),
          (text) => text,
          ["selected.bin"],
        ),
      ).rejects.toThrow();
    },
  );
});

describe("guest file answers", () => {
  it.each(
    [true, false].flatMap((present) =>
      [{ path: "other.txt" }, "download", 42, false, null, ["trace"]].map(
        (unrelated) => ({ present, unrelated }),
      ),
    ),
  )(
    "uses only named data-object metadata (present: $present, unrelated: $unrelated)",
    async ({ present, unrelated }) => {
      const files = await readHomeFiles(
        async () => ({
          result: {
            parts: [
              {
                kind: "file",
                file: { bytes: Buffer.from("source bytes").toString("base64") },
                metadata: {
                  "urn:unrelated": unrelated,
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
    expect(guestFileAnswerBytes(3, 1)).toBe(65_540);
    expect(guestFileAnswerBytes(3, 2)).toBe(131_076);
    const wire = 65_540;
    expect(guestFileAnswerRefusal(3, 1, wire)).toBeInstanceOf(
      AnalysisResourceConstraintError,
    );
    expect(guestFileAnswerRefusal(3, 1, wire * 3)).toBeUndefined();
    expect(guestFileAnswerWorkingBytes(wire * 3)).toBe(wire);
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
      answer_bytes: 135_072,
      answer_ceiling_bytes: ceiling,
      answer_working_bytes: 333,
      answer_copies: 3,
      ceiling_source: "v8.heap_size_limit/4",
    });
    expect(refusal.remediationAction).toContain("v8.heap_size_limit/4");
    expect(refusal.remediationAction).toContain("--max-old-space-size");
    expect(refusal.remediationAction).toContain("Restart REA");
    expect(guestFileAnswerBytes(reported, 2)).toBeGreaterThan(
      guestFileAnswerWorkingBytes(ceiling),
    );
  });

  it("does not ask the computer for a home file past that same ceiling", async () => {
    const failure = await AgentEnvComputer.prototype.homeFiles
      .call({}, ["out.json"], Number.MAX_SAFE_INTEGER)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisResourceConstraintError);
  });
});
