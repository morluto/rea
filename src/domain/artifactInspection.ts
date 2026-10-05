import { z } from "zod";

import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "./artifactGraph.js";
import { canonicalDigest } from "./comparisonSemantics.js";
import { uniqueSorted } from "./canonicalOrdering.js";
import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const textSchema = z.string().min(1);
const evidenceIdSchema = prefixedDigestSchema("ev");
const artifactIdSchema = prefixedDigestSchema("art");

const inspectionObservationSchema = z.strictObject({
  observation_id: prefixedDigestSchema("aio"),
  kind: z.enum(["root-manifest", "artifact", "occurrence", "integrity"]),
  subject: textSchema,
  value: jsonValueSchema,
  evidence_id: evidenceIdSchema,
});

const inspectionRelationshipSchema = z.strictObject({
  relationship_id: prefixedDigestSchema("air"),
  relation: z.enum([
    "contains",
    "extracts",
    "slice-of",
    "embeds",
    "loads",
    "maps-source",
    "derived-from",
  ]),
  source_artifact_id: artifactIdSchema,
  target_artifact_id: artifactIdSchema,
  occurrence_id: prefixedDigestSchema("occ"),
  logical_path: textSchema.nullable(),
  evidence_id: evidenceIdSchema,
});

const inspectionHypothesisSchema = z.strictObject({
  hypothesis_id: prefixedDigestSchema("aih"),
  statement: textSchema,
  confidence: z.enum(["medium", "low"]),
  basis_evidence_ids: z.array(evidenceIdSchema).min(1),
  limitation: textSchema,
});

const inspectionContradictionSchema = z.strictObject({
  contradiction_id: prefixedDigestSchema("aic"),
  statement: textSchema,
  occurrence_id: prefixedDigestSchema("occ"),
  declared_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  observed_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_id: evidenceIdSchema,
});

const nextProbeSchema = z.strictObject({
  operation: textSchema,
  rationale: textSchema,
  authority: z.enum([
    "artifact-bytes",
    "managed-static-analysis",
    "native-analysis-provider",
    "ast-static-analysis",
  ]),
});

const unexploredBranchSchema = z.strictObject({
  branch_id: prefixedDigestSchema("aib"),
  reason: z.enum(["format-specific-analysis-required", "unknown-format"]),
  detail: textSchema,
  next_probe: nextProbeSchema.nullable(),
  evidence_id: evidenceIdSchema,
});

/** Provider-neutral inspection result with its atomic source Evidence. */
export const artifactInspectionResultSchema = z.strictObject({
  inspection_id: prefixedDigestSchema("ai"),
  subject: z.strictObject({
    manifest_id: prefixedDigestSchema("agm"),
    root_artifact_id: artifactIdSchema,
    root_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    root_format: textSchema,
  }),
  substeps: z
    .array(
      z.strictObject({
        substep_id: prefixedDigestSchema("ais"),
        operation: z.literal("inventory_artifact"),
        status: z.literal("completed"),
        evidence_id: evidenceIdSchema,
        evidence: evidenceSchema,
      }),
    )
    .min(1),
  observations: z.array(inspectionObservationSchema),
  derived_relationships: z.array(inspectionRelationshipSchema),
  hypotheses: z.array(inspectionHypothesisSchema),
  contradictions: z.array(inspectionContradictionSchema),
  unexplored_branches: z.array(unexploredBranchSchema),
  next_probes: z.array(nextProbeSchema),
  coverage: z.strictObject({
    status: z.enum(["complete-within-substeps", "partial", "truncated"]),
    substeps_completed: z.literal(1),
    observations_retained: z.number().int().min(0),
    observations_omitted: z.number().int().min(0),
    relationships_retained: z.number().int().min(0),
    relationships_omitted: z.number().int().min(0),
    hypotheses_retained: z.number().int().min(0),
    hypotheses_omitted: z.number().int().min(0),
    unexplored_branches_retained: z.number().int().min(0),
    unexplored_branches_omitted: z.number().int().min(0),
    next_probes_retained: z.number().int().min(0),
    next_probes_omitted: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1),
  limitations: z.array(textSchema),
});

export type ArtifactInspectionResult = z.infer<
  typeof artifactInspectionResultSchema
>;

/** Project one successful inventory Evidence record into an inspection report. */
export const createArtifactInspection = (
  inventoryInput: unknown,
): ArtifactInspectionResult => {
  const inventoryEvidence = parseInventoryEvidence(inventoryInput);
  const inventory = artifactInventoryResultSchema.parse(
    inventoryEvidence.normalized_result,
  );
  const observations = allObservations(
    inventory,
    inventoryEvidence.evidence_id,
  );
  const relationships = allRelationships(
    inventory,
    inventoryEvidence.evidence_id,
  );
  const hypotheses = allHypotheses(inventory, inventoryEvidence.evidence_id);
  const nextProbes = probesFor(inventory);
  const branches = allUnexploredBranches(
    inventory,
    inventoryEvidence.evidence_id,
    nextProbes,
  );
  const retained = {
    observations,
    relationships,
    hypotheses,
    branches,
    probes: nextProbes,
  };
  const omissions = {
    observations: 0,
    relationships: 0,
    hypotheses: 0,
    branches: 0,
    probes: 0,
  };
  const semantic = {
    subject: {
      manifest_id: inventory.manifest.manifest_id,
      root_artifact_id: inventory.manifest.root_artifact_id,
      root_sha256: inventory.manifest.root_sha256,
      root_format: inventory.manifest.root_format,
    },
    substeps: [
      {
        substep_id: `ais_${canonicalDigest(
          {
            operation: "inventory_artifact",
            evidence_id: inventoryEvidence.evidence_id,
          },
          "Artifact inspection",
        )}`,
        operation: "inventory_artifact" as const,
        status: "completed" as const,
        evidence_id: inventoryEvidence.evidence_id,
        evidence: inventoryEvidence,
      },
    ],
    observations: retained.observations,
    derived_relationships: retained.relationships,
    hypotheses: retained.hypotheses,
    contradictions: contradictions(inventory, inventoryEvidence.evidence_id),
    unexplored_branches: retained.branches,
    next_probes: retained.probes,
    coverage: {
      status: inspectionCoverage(inventory, omissions),
      substeps_completed: 1 as const,
      observations_retained: retained.observations.length,
      observations_omitted: omissions.observations,
      relationships_retained: retained.relationships.length,
      relationships_omitted: omissions.relationships,
      hypotheses_retained: retained.hypotheses.length,
      hypotheses_omitted: omissions.hypotheses,
      unexplored_branches_retained: retained.branches.length,
      unexplored_branches_omitted: omissions.branches,
      next_probes_retained: retained.probes.length,
      next_probes_omitted: omissions.probes,
    },
    evidence_links: [inventoryEvidence.evidence_id],
    limitations: uniqueSorted([
      ...inventory.limitations,
      "Inspection derives bounded static hypotheses and next probes; it does not execute the artifact or claim format-specific semantics.",
    ]),
  };
  return artifactInspectionResultSchema.parse({
    ...semantic,
    inspection_id: `ai_${canonicalDigest(semantic, "Artifact inspection")}`,
  });
};

const parseInventoryEvidence = (input: unknown): Evidence => {
  const evidence = parseEvidence(input);
  if (evidence.operation !== "inventory_artifact")
    throw new TypeError(
      "Artifact inspection substep requires inventory_artifact Evidence",
    );
  return evidence;
};

const allObservations = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["observations"] => [
  observation(
    "root-manifest",
    inventory.manifest.root_artifact_id,
    inventory.manifest,
    evidenceId,
  ),
  ...inventory.nodes.map((node) =>
    observation("artifact", node.artifact_id, node, evidenceId),
  ),
  ...inventory.occurrences.map((occurrence) =>
    observation("occurrence", occurrence.occurrence_id, occurrence, evidenceId),
  ),
  ...inventory.integrity_contradictions.map((value) =>
    observation("integrity", value.contradiction_id, value, evidenceId),
  ),
];

const observation = (
  kind: ArtifactInspectionResult["observations"][number]["kind"],
  subject: string,
  value: unknown,
  evidenceId: string,
): ArtifactInspectionResult["observations"][number] => {
  const semantic = {
    kind,
    subject,
    value: jsonValueSchema.parse(value),
    evidence_id: evidenceId,
  };
  return {
    observation_id: `aio_${canonicalDigest(semantic, "Artifact inspection")}`,
    ...semantic,
  };
};

const allRelationships = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["derived_relationships"] =>
  inventory.edges.map((edge) => {
    const semantic = {
      relation: edge.relation,
      source_artifact_id: edge.parent_artifact_id,
      target_artifact_id: edge.child_artifact_id,
      occurrence_id: edge.occurrence_id,
      logical_path: edge.logical_path,
      evidence_id: evidenceId,
    };
    return {
      relationship_id: `air_${canonicalDigest(semantic, "Artifact inspection")}`,
      ...semantic,
    };
  });

const allHypotheses = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["hypotheses"] => {
  const statements =
    inventory.manifest.root_format === "pe"
      ? [
          "The PE artifact may contain managed CLI metadata or native code; inventory bytes alone do not distinguish them.",
        ]
      : ["asar", "javascript-bundle"].includes(inventory.manifest.root_format)
        ? [
            "The artifact may contain a recoverable JavaScript application graph.",
          ]
        : [];
  return statements.map((statement) => {
    const semantic = {
      statement,
      confidence: "low" as const,
      basis_evidence_ids: [evidenceId],
      limitation:
        "Format classification proposes a bounded follow-up; it is not semantic proof.",
    };
    return {
      hypothesis_id: `aih_${canonicalDigest(semantic, "Artifact inspection")}`,
      ...semantic,
    };
  });
};

const contradictions = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["contradictions"] =>
  inventory.integrity_contradictions.map((value) => {
    const semantic = {
      statement: `Declared integrity for ${value.logical_path} contradicts observed bytes.`,
      occurrence_id: value.occurrence_id,
      declared_sha256: value.declared_sha256,
      observed_sha256: value.observed_sha256,
      evidence_id: evidenceId,
    };
    return {
      contradiction_id: `aic_${canonicalDigest(semantic, "Artifact inspection")}`,
      ...semantic,
    };
  });

const probesFor = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] => {
  const format = inventory.manifest.root_format;
  if (["asar", "javascript-bundle", "directory"].includes(format))
    return [
      {
        operation: "analyze_javascript_application",
        rationale:
          "Recover bounded JavaScript modules, source maps, Electron boundaries, and application relationships.",
        authority: "ast-static-analysis",
      },
    ];
  if (format === "pe")
    return [
      {
        operation: "inspect_managed_artifact",
        rationale:
          "Check execution-free CLI metadata before choosing a deep native provider.",
        authority: "managed-static-analysis",
      },
      {
        operation: "open_binary",
        rationale:
          "Open as native code only when managed inspection reports a native or mixed boundary.",
        authority: "native-analysis-provider",
      },
    ];
  if (["mach-o", "mach-o-universal", "elf"].includes(format))
    return [
      {
        operation: "open_binary",
        rationale:
          "Bind one deep native provider before function-level analysis.",
        authority: "native-analysis-provider",
      },
    ];
  if (format === "plist")
    return [
      {
        operation: "inspect_plist",
        rationale: "Parse property-list values without executing the artifact.",
        authority: "artifact-bytes",
      },
    ];
  return [];
};

const allUnexploredBranches = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
  nextProbes: ArtifactInspectionResult["next_probes"],
): ArtifactInspectionResult["unexplored_branches"] => {
  const branches: ArtifactInspectionResult["unexplored_branches"] = [];
  branches.push(
    ...nextProbes.map((probe) =>
      branch(
        "format-specific-analysis-required",
        `${probe.operation} was not run by provider-neutral artifact inspection.`,
        probe,
        evidenceId,
      ),
    ),
  );
  if (inventory.manifest.root_format === "unknown")
    branches.push(
      branch(
        "unknown-format",
        "Artifact bytes did not match an admitted format classifier.",
        null,
        evidenceId,
      ),
    );
  return branches;
};

const branch = (
  reason: ArtifactInspectionResult["unexplored_branches"][number]["reason"],
  detail: string,
  nextProbe: ArtifactInspectionResult["next_probes"][number] | null,
  evidenceId: string,
): ArtifactInspectionResult["unexplored_branches"][number] => {
  const semantic = {
    reason,
    detail,
    next_probe: nextProbe,
    evidence_id: evidenceId,
  };
  return {
    branch_id: `aib_${canonicalDigest(semantic, "Artifact inspection")}`,
    ...semantic,
  };
};

const inspectionCoverage = (
  _inventory: ArtifactInventoryResult,
  omissions: Readonly<Record<string, number>>,
): ArtifactInspectionResult["coverage"]["status"] => {
  if (Object.values(omissions).some((count) => count > 0)) return "truncated";
  return "complete-within-substeps";
};
