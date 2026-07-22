import { z } from "zod";

const valuesAt = (node, path) => {
  if (typeof node !== "object" || node === null) return [];
  if ("anyOf" in node && Array.isArray(node.anyOf))
    return node.anyOf.flatMap((alternative) => valuesAt(alternative, path));
  if (path.length === 0)
    return "const" in node &&
      (typeof node.const === "number" || typeof node.const === "string")
      ? [node.const]
      : [];
  if (
    !("properties" in node) ||
    typeof node.properties !== "object" ||
    node.properties === null
  )
    return [];
  const [segment, ...remaining] = path;
  return segment !== undefined && segment in node.properties
    ? valuesAt(node.properties[segment], remaining)
    : [];
};

const versionAt = (schema, path) => {
  const versions = [
    ...new Set(valuesAt(z.toJSONSchema(schema), path).map(String)),
  ];
  if (versions.length !== 1)
    throw new Error(
      `Schema version path ${path.join(".")} has ${String(versions.length)} constant values`,
    );
  const version = versions[0];
  if (version === undefined) throw new Error("Schema version disappeared");
  return /^\d+$/u.test(version) ? Number(version) : version;
};

const durableSchemaDefinitions = (sources) => [
  [
    "analysis_snapshot",
    sources.analysisSnapshot.analysisSnapshotSchema,
    ["snapshot_version"],
  ],
  [
    "artifact_graph",
    sources.artifactGraph.artifactInventoryResultSchema,
    ["manifest", "schema_version"],
  ],
  [
    "artifact_extraction",
    sources.artifactGraph.artifactExtractionResultSchema,
    ["extraction_manifest", "schema_version"],
  ],
  ["evidence", sources.evidence.evidenceSchema, ["schema_version"]],
  [
    "evidence_bundle",
    sources.evidenceBundle.evidenceBundleSchema,
    ["bundle_version"],
  ],
  [
    "evidence_completion_ledger",
    sources.evidenceCompletion.evidenceCompletionLedgerSchema,
    ["schema_version"],
  ],
  [
    "evidence_completion_manifest",
    sources.completionGeneration.completionManifestSchema,
    ["schema_version"],
  ],
  [
    "investigation_run",
    sources.investigationWorkspace.investigationRunSchema,
    ["schema_version"],
  ],
  [
    "investigation_run_summary",
    sources.investigationWorkspace.investigationRunSummarySchema,
    ["schema_version"],
  ],
  [
    "investigation_workspace",
    sources.investigationWorkspace.investigationWorkspaceSchema,
    ["workspace_version"],
  ],
  [
    "javascript_application_graph",
    sources.javascriptApplicationGraph.javascriptApplicationGraphSchema,
    ["schema_version"],
  ],
  [
    "javascript_application_version_comparison",
    sources.javascriptVersionComparison
      .applicationVersionComparisonResultSchema,
    ["schema_version"],
  ],
  [
    "javascript_feature_trace",
    sources.javascriptFeatureTrace.applicationFeatureTraceResultSchema,
    ["schema_version"],
  ],
  [
    "process_capture",
    sources.processCapture.processCaptureSchema,
    ["schema_version"],
  ],
  [
    "reconstruction_verification",
    sources.reconstructionVerification.reconstructionSpecificationSchema,
    ["schema_version"],
  ],
  [
    "residual_unknown",
    sources.residualUnknown.residualUnknownSchema,
    ["registry_version"],
  ],
];

const observationSchemaDefinitions = (sources) => [
  [
    "managed_artifact_inspection",
    sources.managedArtifact.managedArtifactInspectionSchema,
    ["schema_version"],
  ],
  [
    "managed_member_inspection",
    sources.managedArtifact.managedMemberInspectionSchema,
    ["schema_version"],
  ],
  [
    "managed_native_boundary_inspection",
    sources.managedArtifact.managedNativeBoundaryInspectionSchema,
    ["schema_version"],
  ],
  [
    "managed_member_comparison",
    sources.managedComparison.managedMemberComparisonResultSchema,
    ["schema_version"],
  ],
  [
    "managed_native_verification",
    sources.managedNativeVerification.managedNativeVerificationResultSchema,
    ["schema_version"],
  ],
  [
    "browser_target_list",
    sources.browserObservation.browserTargetListSchema,
    ["schema_version"],
  ],
  [
    "electron_page_inspection",
    sources.electronObservation.electronPageInspectionSchema,
    ["schema_version"],
  ],
  [
    "electron_target_list",
    sources.electronObservation.electronTargetListSchema,
    ["schema_version"],
  ],
  [
    "javascript_application_analysis",
    sources.javascriptApplicationAnalysis
      .javascriptApplicationAnalysisResultSchema,
    ["schema_version"],
  ],
  [
    "web_bundle_analysis",
    sources.webBundleAnalysis.webBundleAnalysisSchema,
    ["schema_version"],
  ],
  [
    "web_capture_diff",
    sources.webCaptureDiff.webCaptureDiffSchema,
    ["schema_version"],
  ],
  [
    "web_mcp_discovery",
    sources.webMcpDiscovery.webMcpDiscoverySchema,
    ["schema_version"],
  ],
  [
    "web_observation_session",
    sources.browserSession.webObservationSessionSchema,
    ["schema_version"],
  ],
  [
    "web_page_inspection",
    sources.browserObservation.webPageInspectionSchema,
    ["schema_version"],
  ],
  [
    "web_screenshot",
    sources.webScreenshot.webScreenshotSchema,
    ["schema_version"],
  ],
  [
    "web_screenshot_diff",
    sources.webScreenshot.webScreenshotDiffSchema,
    ["schema_version"],
  ],
];

/** Derive the catalog of durable and observation schema versions. */
export const schemaCatalog = (sources) =>
  [
    ...durableSchemaDefinitions(sources),
    ...observationSchemaDefinitions(sources),
  ]
    .map(([id, schema, path]) => {
      try {
        return { id, version: versionAt(schema, path) };
      } catch (cause) {
        throw new Error(`Could not derive ${id} schema version`, { cause });
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
