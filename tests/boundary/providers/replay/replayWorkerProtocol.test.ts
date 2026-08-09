import { describe, expect, it } from "vitest";

import { parseReplayWorkerResponse } from "../../../../src/replay/ReplayWorkerProtocol.js";

const digest = "1".repeat(64);
const cases = [{ case_id: "case-1", sha256: digest }];
const outcome = {
  case_id: "case-1",
  outcome: "return" as const,
  value: { parsed: true },
  input_sha256: digest,
  output_sha256: null,
  truncated: false as const,
};

describe("replay worker protocol", () => {
  it("accepts only the exact committed case sequence", () => {
    expect(
      parseReplayWorkerResponse(
        { schema_version: 1, left: [outcome] },
        cases,
        "single",
      ),
    ).toMatchObject({ left: [outcome] });
    expect(() =>
      parseReplayWorkerResponse(
        { schema_version: 1, left: [{ ...outcome, case_id: "forged" }] },
        cases,
        "single",
      ),
    ).toThrow("case identity changed");
    expect(() =>
      parseReplayWorkerResponse(
        {
          schema_version: 1,
          left: [{ ...outcome, input_sha256: "2".repeat(64) }],
        },
        cases,
        "single",
      ),
    ).toThrow("case identity changed");
  });

  it("requires the exact differential shape and strict outcomes", () => {
    expect(() =>
      parseReplayWorkerResponse(
        { schema_version: 1, left: [outcome] },
        cases,
        "differential",
      ),
    ).toThrow();
    expect(() =>
      parseReplayWorkerResponse(
        {
          schema_version: 1,
          left: [{ ...outcome, unexpected: true }],
        },
        cases,
        "single",
      ),
    ).toThrow();
    expect(() =>
      parseReplayWorkerResponse(
        {
          schema_version: 1,
          left: [{ ...outcome, outcome: "exception", value: undefined }],
        },
        cases,
        "single",
      ),
    ).toThrow();
  });
});
