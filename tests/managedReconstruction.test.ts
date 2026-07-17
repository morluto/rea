import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { importManagedReconstructionEvidence } from "../src/application/ManagedReconstructionService.js";
import { MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE } from "../src/contracts/managedWorkflowExamples.js";
import {
  importManagedReconstruction,
  managedReconstructionImportInputSchema,
} from "../src/domain/managedReconstruction.js";
import { managedMemberInspectionSchema } from "../src/domain/managedArtifact.js";
import { createEvidence } from "../src/domain/evidence.js";

const exampleInput = () =>
  managedReconstructionImportInputSchema.parse(
    MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
  );

const exampleMethod = () => {
  const method = exampleInput().methods[0];
  if (method === undefined) throw new Error("missing example method");
  return method;
};

describe("managed decompiler reconstruction import", () => {
  it("imports decompiler output as inference locked to static IL evidence", () => {
    const result = importManagedReconstruction(exampleInput());

    expect(result).toMatchObject({
      schema_version: 1,
      phase: "reconstruction-import",
      executed: false,
      static_observation: {
        artifact_sha256: "2".repeat(64),
        mvid: "11112222-3333-4444-9555-666677778888",
      },
      decompiler: {
        name: "ilspycmd",
        version: "9.1.0.7988",
        family: "ilspy",
      },
      summary: {
        imported_methods: 1,
        decompiled_csharp_methods: 1,
      },
      methods: [
        {
          token: "0x06000001",
          signature_sha256: "3".repeat(64),
          normalized_il_sha256: "5".repeat(64),
          validation: {
            matched_static_member: true,
            exact_build_required: true,
            canonical_observation: false,
            confidence_floor: "inference",
          },
        },
      ],
    });
    expect(result.reconstruction_id).toMatch(/^mre_[a-f0-9]{64}$/u);
    expect(result.methods[0]?.reconstruction.text_sha256).toBe(
      createHash("sha256")
        .update("internal static void Main() { }")
        .digest("hex"),
    );
    expect(result.limitations.join(" ")).toContain(
      "metadata and IL observations remain canonical",
    );
  });

  it("rejects reconstruction text hash drift", () => {
    expect(() =>
      importManagedReconstruction({
        ...exampleInput(),
        methods: [
          {
            ...exampleMethod(),
            reconstruction: {
              ...exampleMethod().reconstruction,
              text_sha256: "0".repeat(64),
            },
          },
        ],
      }),
    ).toThrow(/text hash mismatch/u);
  });

  it("rejects stale method locks", () => {
    expect(() =>
      importManagedReconstruction({
        ...exampleInput(),
        methods: [
          {
            ...exampleMethod(),
            normalized_il_sha256: "6".repeat(64),
          },
        ],
      }),
    ).toThrow(/does not match/u);
  });

  it("rejects reconstruction locks for partial CIL without normalized identity", () => {
    const input = exampleInput();
    const observed = managedMemberInspectionSchema.parse(
      input.static_members.normalized_result,
    );
    const method = observed.methods.items[0];
    if (method === undefined) throw new Error("missing observed method");
    const partial = {
      ...observed,
      methods: {
        ...observed.methods,
        items: [
          {
            ...method,
            body: {
              ...method.body,
              status: "partial" as const,
              normalized_il_sha256: null,
              truncated_instructions: 1,
              issue: "instruction limit reached",
            },
          },
        ],
      },
      coverage: { state: "partial" as const, issues: [] },
    };
    const partialEvidence = createEvidence(
      undefined,
      input.static_members.provider,
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: partial,
        rawResult: null,
        limitations: partial.limitations,
      },
    );

    expect(() =>
      importManagedReconstruction({
        ...input,
        static_members: partialEvidence,
        methods: [
          {
            ...exampleMethod(),
            normalized_il_sha256: null,
          },
        ],
      }),
    ).toThrow(/does not match/u);
  });

  it("wraps imported reconstruction in Evidence v2", () => {
    const evidence = importManagedReconstructionEvidence(exampleInput());

    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    expect(evidence.value).toMatchObject({
      operation: "import_managed_reconstruction",
      provider: { id: "rea-dotnet-workflows" },
      confidence: "inferred",
      authority: "analyst-inference",
      normalized_result: {
        phase: "reconstruction-import",
        methods: [
          {
            reconstruction: {
              kind: "decompiled-csharp",
              language: "csharp",
            },
          },
        ],
      },
    });
  });
});
