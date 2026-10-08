import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE } from "../../contracts/managed/managedWorkflowExamples.js";
import {
  importManagedReconstruction,
  managedReconstructionImportInputSchema,
} from "../../domain/managed/managedReconstruction.js";
import { managedMemberInspectionSchema } from "../../domain/managed/managedArtifact.js";
import { createEvidence } from "../../domain/evidence.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { importManagedReconstructionEvidence } from "./ManagedReconstructionService.js";

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
    const method = observed.methods[0];
    if (method === undefined) throw new Error("missing observed method");
    const partial = {
      ...observed,
      methods: [
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

  it("wraps imported reconstruction in Evidence", () => {
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

describe("managed reconstruction input diagnostics", () => {
  it("lists schema issues for malformed raw input", () => {
    const result = importManagedReconstructionEvidence({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: expect.arrayContaining([
        expect.objectContaining({ reason: "missing_argument" }),
      ]),
    });
  });

  it("keeps the failed domain constraint as an issue message", () => {
    const result = importManagedReconstructionEvidence({
      ...MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
      methods: [
        {
          ...exampleMethod(),
          reconstruction: {
            ...exampleMethod().reconstruction,
            text_sha256: "0".repeat(64),
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: [],
          reason: "invalid_value",
          message: expect.stringMatching(/text hash mismatch/u),
        },
      ],
    });
  });

  it("reports nested Evidence schema issues without a misleading request path", () => {
    const input = exampleInput();
    const malformed = createEvidence(undefined, input.static_members.provider, {
      operation: "inspect_managed_members",
      parameters: {},
      result: {
        ...input.static_members.normalized_result,
        artifact: { sha256: 7 },
      },
      rawResult: null,
    });
    const result = importManagedReconstructionEvidence({
      ...MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
      static_members: malformed,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ _tag: "AnalysisInputError" });
    const issues =
      result.error instanceof AnalysisInputError ? result.error.issues : [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(({ path }) => path.length === 0)).toBe(true);
    expect(issues).toContainEqual(
      expect.objectContaining({
        reason: "invalid_value",
        message: expect.stringContaining(
          "nested Evidence value failed validation at artifact",
        ),
      }),
    );
  });
});
