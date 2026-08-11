import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
  MANAGED_MEMBER_FIXTURE_LIMITS,
} from "./ManagedPe.fixture.js";

describe("managed CIL limits", () => {
  it("marks instruction-limited CIL as partial without assigning normalized identity", () => {
    const bytes = buildManagedPeFixture();
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
      {
        ...MANAGED_MEMBER_FIXTURE_LIMITS,
        maxMethodInstructions: 1,
      },
    );
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
