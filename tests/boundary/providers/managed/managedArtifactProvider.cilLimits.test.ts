import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import { buildManagedPeFixture } from "../../../fixtures/managedPe.js";

const memberLimits = {
  typeOffset: 0,
  typeLimit: 100,
  methodOffset: 0,
  methodLimit: 100,
  fieldOffset: 0,
  fieldLimit: 100,
  memberRefOffset: 0,
  memberRefLimit: 100,
  edgeOffset: 0,
  edgeLimit: 100,
  instructionAnchorLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
  maxMethodBodyBytes: 1024 * 1024,
  maxMethodInstructions: 1_000,
};

describe("managed CIL limits", () => {
  it("marks instruction-limited CIL as partial without assigning normalized identity", () => {
    const bytes = buildManagedPeFixture();
    const result = inspectManagedMembersBytes(bytes, target(bytes), {
      ...memberLimits,
      maxMethodInstructions: 1,
    });
    const il = bytes.subarray(0x0a01, 0x0a0d);

    expect(result.metadata.status).toBe("complete");
    expect(result.methods.items[0]?.body).toMatchObject({
      status: "partial",
      il_size: 12,
      il_sha256: createHash("sha256").update(il).digest("hex"),
      normalized_il_sha256: null,
      instruction_count: 1,
      decoded_instruction_count: 1,
      truncated_instructions: 1,
      issue:
        "Instruction decode reached max_method_instructions 1 before the end of the method body",
    });
    expect(result.coverage).toEqual({
      state: "partial",
      issues: [
        {
          code: "limit-exceeded",
          scope: "method.0x06000001.body.instructions",
          offset: 0x0a00,
          detail:
            "Instruction decode reached max_method_instructions 1 before the end of the method body",
        },
      ],
    });
    expect(result.limitations.join(" ")).toContain(
      "has no normalized CIL identity",
    );
  });
});
const target = (bytes: Buffer): BinaryTarget => ({
  path: "/fixture.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
  executableRole: "application",
  managed: true,
});
