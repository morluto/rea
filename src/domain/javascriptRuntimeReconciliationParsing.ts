import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
  webPageInspectionSchema,
  type WebPageInspection,
} from "./browserObservation.js";
import {
  electronFileRootsSchema,
  electronPageInspectionSchema,
  type ElectronPageInspection,
} from "./electronObservation.js";
import { parseEvidence, type Evidence } from "./evidence.js";
import {
  javascriptApplicationAnalysisResultSchema,
  type JavaScriptApplicationAnalysisResult,
} from "./javascriptApplicationAnalysis.js";
import {
  compareCodePoints,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type { ReconcileJavaScriptRuntimeInput } from "./javascriptRuntimeReconciliationSchemas.js";

type StaticLayerInput =
  ReconcileJavaScriptRuntimeInput["static_layers"][number];
type RuntimeMapping = StaticLayerInput["runtime_mappings"][number];

export interface ParsedStaticLayer {
  readonly layerId: string;
  readonly role: StaticLayerInput["role"];
  readonly evidence: Evidence;
  readonly result: JavaScriptApplicationAnalysisResult;
  readonly graph: JavaScriptApplicationGraph;
  readonly runtimeMappings: readonly RuntimeMapping[];
  readonly sourceMapReadApproved: boolean;
}

interface RuntimeCaptureBase {
  readonly evidence: Evidence;
  readonly captureSha256: string;
  readonly scriptsCompleteWithinScope: boolean;
}

export type ParsedRuntimeCapture =
  | (RuntimeCaptureBase & {
      readonly kind: "browser";
      readonly inspection: WebPageInspection;
    })
  | (RuntimeCaptureBase & {
      readonly kind: "electron";
      readonly inspection: ElectronPageInspection;
    });

/** Parse and semantically bind every static analysis Evidence layer. */
export const parseStaticLayers = (
  layers: readonly StaticLayerInput[],
): ParsedStaticLayer[] =>
  layers
    .map((layer) => parseStaticLayer(layer))
    .sort((left, right) => compareCodePoints(left.layerId, right.layerId));

/** Parse only supported passive web/Electron inspection Evidence. */
export const parseRuntimeCaptures = (
  observations: readonly Evidence[],
): ParsedRuntimeCapture[] =>
  observations
    .map((observation) => parseRuntimeCapture(observation))
    .sort((left, right) =>
      compareCodePoints(left.evidence.evidence_id, right.evidence.evidence_id),
    );

export const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Runtime reconciliation could not canonicalize input");
  return createHash("sha256").update(encoded).digest("hex");
};

const parseStaticLayer = (layer: StaticLayerInput): ParsedStaticLayer => {
  const evidence = parseEvidence(layer.analysis);
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  assertEvidenceIdentity(evidence, {
    operation: "analyze_javascript_application",
    predicate: `rea.javascript-application-analysis/v${String(result.schema_version)}`,
    providerId: "rea-javascript-application",
    providerName: "REA JavaScript application analyzer",
    providerVersion: "1",
    authority: "shipped-artifact",
    confidence: "derived",
  });
  if (
    evidence.subject === null ||
    evidence.subject.digest.sha256 !== result.root_artifact_sha256 ||
    evidence.subject.format !== result.format ||
    evidence.subject.local_path !== result.input_path
  )
    throw new TypeError(
      "JavaScript application Evidence subject disagrees with its result",
    );
  const parameters = z
    .object({
      approved: z.literal(true),
      source_map_read_approved: z.boolean(),
    })
    .passthrough()
    .parse(evidence.parameters);
  return {
    layerId: `jrl_${digestCanonical({
      role: layer.role,
      evidence_id: evidence.evidence_id,
      runtime_mappings: layer.runtime_mappings,
    })}`,
    role: layer.role,
    evidence,
    result,
    graph: result.graph,
    runtimeMappings: layer.runtime_mappings,
    sourceMapReadApproved: parameters.source_map_read_approved,
  };
};

const parseRuntimeCapture = (input: Evidence): ParsedRuntimeCapture => {
  const evidence = parseEvidence(input);
  if (evidence.operation === "inspect_web_page") {
    assertEvidenceIdentity(evidence, {
      operation: "inspect_web_page",
      predicate: "rea.web-page-inspection/v2",
      providerId: "rea-cdp-browser",
      providerName: "REA Chrome DevTools Protocol observation provider",
      providerVersion: "2",
      authority: "external-service",
      confidence: "observed",
    });
    const inspection = webPageInspectionSchema.parse(
      evidence.normalized_result,
    );
    assertRuntimeParameters(evidence, {
      kind: "browser",
      targetId: inspection.target.target_id,
      targetOrigin: inspection.target.origin,
      sourceIncluded: inspection.scripts.items.some(
        ({ source }) => source.included,
      ),
    });
    return {
      kind: "browser",
      evidence,
      inspection,
      captureSha256: digestCanonical(inspection),
      scriptsCompleteWithinScope: scriptsComplete(inspection.completeness),
    };
  }
  if (evidence.operation === "inspect_electron_page") {
    assertEvidenceIdentity(evidence, {
      operation: "inspect_electron_page",
      predicate: "rea.electron-page-inspection/v1",
      providerId: "rea-cdp-electron",
      providerName: "REA Electron file-page CDP observation provider",
      providerVersion: "1",
      authority: "external-service",
      confidence: "observed",
    });
    const inspection = electronPageInspectionSchema.parse(
      evidence.normalized_result,
    );
    assertRuntimeParameters(evidence, {
      kind: "electron",
      targetId: inspection.target.target_id,
      sourceIncluded: inspection.scripts.items.some(
        ({ source }) => source.included,
      ),
    });
    return {
      kind: "electron",
      evidence,
      inspection,
      captureSha256: digestCanonical(inspection),
      scriptsCompleteWithinScope: scriptsComplete(inspection.completeness),
    };
  }
  throw new TypeError(
    "Runtime reconciliation requires inspect_web_page or inspect_electron_page Evidence",
  );
};

const assertRuntimeParameters = (
  evidence: Evidence,
  expected:
    | {
        readonly kind: "browser";
        readonly targetId: string;
        readonly targetOrigin: string;
        readonly sourceIncluded: boolean;
      }
    | {
        readonly kind: "electron";
        readonly targetId: string;
        readonly sourceIncluded: boolean;
      },
): void => {
  const common = {
    target_id: z.string().trim().min(1).max(256),
    cdp_endpoint: browserEndpointSchema,
    include_script_sources: z.boolean(),
  };
  if (expected.kind === "browser") {
    const parameters = z
      .object({ ...common, allowed_origins: browserAllowedOriginsSchema })
      .passthrough()
      .parse(evidence.parameters);
    if (parameters.target_id !== expected.targetId)
      throw new TypeError(
        "Runtime Evidence target disagrees with its captured result",
      );
    if (!parameters.allowed_origins.includes(expected.targetOrigin))
      throw new TypeError(
        "Browser Evidence target is outside its recorded origin scope",
      );
    if (expected.sourceIncluded && !parameters.include_script_sources)
      throw new TypeError(
        "Runtime Evidence contains source without source-capture approval",
      );
    return;
  }
  const parameters = z
    .object({
      ...common,
      allowed_file_roots: electronFileRootsSchema,
      source_capture_approved: z.boolean(),
    })
    .passthrough()
    .parse(evidence.parameters);
  if (parameters.target_id !== expected.targetId)
    throw new TypeError(
      "Runtime Evidence target disagrees with its captured result",
    );
  if (
    expected.sourceIncluded &&
    (!parameters.include_script_sources ||
      parameters.source_capture_approved !== true)
  )
    throw new TypeError(
      "Runtime Evidence contains source without source-capture approval",
    );
};

const scriptsComplete = (completeness: {
  readonly truncated_sections: readonly string[];
  readonly unavailable_sections: readonly string[];
  readonly dropped_events: { readonly scripts: number };
}): boolean =>
  !completeness.truncated_sections.includes("scripts") &&
  !completeness.unavailable_sections.includes("scripts") &&
  completeness.dropped_events.scripts === 0;

const assertEvidenceIdentity = (
  evidence: Evidence,
  expected: {
    readonly operation: string;
    readonly predicate: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly providerVersion: string;
    readonly authority: Evidence["authority"];
    readonly confidence: Evidence["confidence"];
  },
): void => {
  if (
    evidence.operation !== expected.operation ||
    evidence.predicate_type !== expected.predicate ||
    evidence.provider.id !== expected.providerId ||
    evidence.provider.name !== expected.providerName ||
    evidence.provider.version !== expected.providerVersion ||
    evidence.authority !== expected.authority ||
    evidence.confidence !== expected.confidence
  )
    throw new TypeError(
      `Evidence does not match the supported ${expected.operation} contract`,
    );
};
