import { describe, expect, it } from "vitest";

import { traceJavaScriptSemanticsRequestSchema } from "../../../src/contracts/applicationWorkflowInputContracts.js";
import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import {
  artifactInspectionInputSchema,
  artifactInventoryInputSchema,
} from "../../../src/contracts/artifactToolContracts.js";
import {
  MANAGED_WORKFLOW_TOOL_CONTRACTS,
  managedApplicationGraphReferenceInputSchema,
  managedNativeVerificationReferenceInputSchema,
  compareManagedMembersReferenceInputSchema,
} from "../../../src/contracts/managedWorkflowToolContracts.js";
import {
  PROMPT_CONTRACTS,
  renderGuidedPrompt,
} from "../../../src/contracts/promptContracts.js";
import {
  annotationsFromEffects,
  toolContractMetadata,
} from "../../../src/contracts/toolEffects.js";
import {
  requireOutputSchema,
  toolAvailability,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE } from "../../../src/contracts/javascriptApplicationWorkflowExamples.js";

const EVIDENCE_ID = `ev_${"a".repeat(64)}`;

const workflowInput = (name: string) => {
  const contract = MANAGED_WORKFLOW_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing ${name} contract`);
  return contract.examples[0].input;
};

describe("contract validation boundaries", () => {
  it("rejects missing and duplicated application Evidence references", () => {
    const query = {
      seed: { kind: "literal" as const, value: "renderer" },
      direction: "callers" as const,
    };
    const missing = traceJavaScriptSemanticsRequestSchema.safeParse({ query });
    expect(missing.success).toBe(false);

    const evidence = JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application;
    const duplicated = traceJavaScriptSemanticsRequestSchema.safeParse({
      application: evidence,
      application_evidence_id: evidence.evidence_id,
      query,
    });
    expect(duplicated.success).toBe(false);
  });

  it("rejects managed Evidence identity collisions", () => {
    const comparison = workflowInput("compare_managed_members");
    expect(
      compareManagedMembersReferenceInputSchema.safeParse({
        ...comparison,
        left_evidence_id: EVIDENCE_ID,
        right_evidence_id: EVIDENCE_ID,
      }).success,
    ).toBe(false);

    const native = workflowInput("verify_managed_native_boundaries");
    expect(
      managedNativeVerificationReferenceInputSchema.safeParse({
        ...native,
        managed_boundaries_evidence_id: EVIDENCE_ID,
        native_observation_evidence_ids: [EVIDENCE_ID, EVIDENCE_ID],
      }).success,
    ).toBe(false);

    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({
        managed_artifact_evidence_id: EVIDENCE_ID,
        managed_members_evidence_id: EVIDENCE_ID,
      }).success,
    ).toBe(false);
    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({}).success,
    ).toBe(false);
  });

  it("accepts each complete managed application Evidence source", () => {
    for (const input of [
      { managed_artifact_evidence_id: EVIDENCE_ID },
      { managed_members_evidence_id: EVIDENCE_ID },
      { managed_native_boundaries_evidence_id: EVIDENCE_ID },
    ])
      expect(
        managedApplicationGraphReferenceInputSchema.safeParse(input).success,
      ).toBe(true);
  });

  it("requires explicit approval for record-and-continue artifact inspection", () => {
    const input = {
      integrity_policy: "record-and-continue" as const,
      integrity_continue_approved: false,
    };
    expect(artifactInventoryInputSchema.safeParse(input).success).toBe(false);
    expect(artifactInspectionInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects contradictory tool availability states", () => {
    const inventory = buildCapabilityInventory(
      { open: false, capabilities: [] },
      {
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
        investigationInputRoots: 0,
      },
    );
    const unavailable = inventory.find(({ available }) => !available);
    expect(unavailable).toBeDefined();
    expect(toolAvailability.safeParse(unavailable).success).toBe(true);
    expect(
      toolAvailability.safeParse({ ...unavailable, available: true }).success,
    ).toBe(false);
    expect(
      toolAvailability.safeParse({
        ...unavailable,
        available: false,
        reason: "available",
      }).success,
    ).toBe(false);
  });

  it("covers deterministic contract rendering and defensive helper errors", () => {
    const rendered = renderGuidedPrompt(PROMPT_CONTRACTS[0], {
      zulu: "last",
      alpha: "first",
    });
    expect(rendered).toContain('"alpha":"first"');
    expect(
      annotationsFromEffects({
        mutatesTarget: false,
        mutatesSession: false,
        writesFilesystem: false,
        launchesProcess: false,
        accessesNetwork: true,
        changesUiState: false,
        mayDiscardData: false,
        idempotent: true,
      }).openWorldHint,
    ).toBe(true);
    expect(() => toolContractMetadata("missing_tool")).toThrow(
      /Missing effect audit/u,
    );
    expect(() => requireOutputSchema({}, "missing_output")).toThrow(
      /Missing output schema/u,
    );
  });
});
