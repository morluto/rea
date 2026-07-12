import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { createEvidence, evidenceSchema } from "../src/domain/evidence.js";
import { jsonValueSchema } from "../src/hopper/protocol.js";

const TARGET: BinaryTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
  loaderArgs: ["-l", "Mach-O", "--aarch64"],
};

describe("analysis evidence", () => {
  it("preserves strict JSON inputs and results without timestamps", () => {
    const evidence = createEvidence(TARGET, {
      operation: "procedure_info",
      parameters: { procedure: "0x1000", document: null },
      result: { name: "main" },
    });
    expect(evidenceSchema.parse(evidence)).toEqual(evidence);
    expect(jsonValueSchema.parse(evidence)).toEqual(evidence);
    expect(evidence).toMatchObject({
      schema_version: 1,
      artifact: {
        path: "/tmp/fixture",
        sha256: "a".repeat(64),
        architecture: "arm64",
      },
      provider: { id: "hopper", version: null },
      operation: "procedure_info",
      confidence: "observed",
      limitations: [],
    });
    expect(evidence).not.toHaveProperty("timestamp");
    expect(evidence).not.toHaveProperty("evidence_id");
  });

  it("marks missing fixed-target identity as unavailable", () => {
    expect(
      createEvidence(undefined, {
        operation: "health",
        parameters: {},
        result: null,
      }),
    ).toMatchObject({
      artifact: null,
      limitations: [
        "Artifact identity is unavailable for this fixed-target adapter.",
      ],
    });
  });
});
