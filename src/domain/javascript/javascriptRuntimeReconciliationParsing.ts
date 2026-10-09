import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
  webPageInspectionSchema,
  type WebPageInspection,
} from "../browserObservation.js";
import {
  classifyBrowserCompleteness,
  type BrowserCompleteness,
} from "../browserCompleteness.js";
import {
  electronPageInspectionSchema,
  type ElectronPageInspection,
} from "./electronObservation.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeKindSchema,
  type JavaScriptRuntimeObservation,
  type JavaScriptRuntimeLocation,
} from "./javascriptRuntimeObservation.js";
import { canonicalDigest } from "../comparisonSemantics.js";
import { compareCodePoints } from "../canonicalOrdering.js";
import { parseEvidence, type Evidence } from "../evidence.js";
import {
  javascriptApplicationAnalysisResultSchema,
  type JavaScriptApplicationAnalysisResult,
} from "./javascriptApplicationAnalysis.js";
import { type JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { parseActiveElectronCapture } from "./javascriptRuntimeReconciliationActive.js";
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
}

interface RuntimeCaptureBase {
  readonly evidence: Evidence;
  readonly captureSha256: string;
  readonly scriptsCompleteWithinScope: boolean;
}

interface NormalizedV8Inspection {
  readonly target:
    | {
        readonly target_id: string;
        readonly type: string;
        readonly title: string;
        readonly attached: boolean;
        readonly file_path: string;
      }
    | {
        readonly target_id: string;
        readonly type: string;
        readonly title: string;
        readonly attached: boolean;
        readonly url: string;
      }
    | {
        readonly target_id: string;
        readonly type: string;
        readonly title: string;
        readonly attached: boolean;
        readonly unresolved_location: Extract<
          JavaScriptRuntimeObservation["target"]["location"],
          { kind: "unresolved" }
        >;
      };
  readonly frames: readonly [];
  readonly scripts: {
    readonly items: readonly (Readonly<{
      script_key: string;
      frame_id: string | null;
      cdp_hash: string | null;
      length: number | null;
      is_module: boolean | null;
      language: null;
      source: { readonly included: false; readonly reason: string };
    }> &
      ({ readonly file_path: string } | { readonly url: string }))[];
  };
  readonly workers: readonly [];
  readonly completeness: BrowserCompleteness;
}

export type ParsedRuntimeCapture =
  | (RuntimeCaptureBase & {
      readonly kind: "browser";
      readonly inspection: WebPageInspection;
    })
  | (RuntimeCaptureBase & {
      readonly kind: "electron";
      readonly inspection: ElectronPageInspection;
    })
  | (RuntimeCaptureBase & {
      readonly kind: "v8-inspector";
      readonly inspection: NormalizedV8Inspection;
    })
  | (RuntimeCaptureBase & {
      readonly kind: "electron-active";
      readonly inspection: {
        readonly target: {
          readonly target_id: string;
          readonly type: string;
          readonly title: string;
          readonly attached: boolean;
          readonly file_path: string;
        };
        readonly frames: readonly [];
        readonly scripts: { readonly items: readonly [] };
        readonly workers: readonly [];
        readonly completeness: BrowserCompleteness;
      };
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

const parseStaticLayer = (layer: StaticLayerInput): ParsedStaticLayer => {
  const evidence = parseEvidence(layer.analysis);
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  assertEvidenceIdentity(evidence, {
    operation: "analyze_javascript_application",
    predicate: "rea.javascript-application-analysis",
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
  return {
    layerId: `jrl_${canonicalDigest(
      {
        role: layer.role,
        evidence_id: evidence.evidence_id,
        runtime_mappings: layer.runtime_mappings,
      },
      "Runtime reconciliation",
    )}`,
    role: layer.role,
    evidence,
    result,
    graph: result.graph,
    runtimeMappings: layer.runtime_mappings,
  };
};

const parseRuntimeCapture = (input: Evidence): ParsedRuntimeCapture => {
  const evidence = parseEvidence(input);
  if (evidence.operation === "inspect_web_page") {
    assertEvidenceIdentity(evidence, {
      operation: "inspect_web_page",
      predicate: "rea.web-page-inspection",
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
      captureSha256: canonicalDigest(inspection, "Runtime reconciliation"),
      scriptsCompleteWithinScope: scriptsComplete(inspection.completeness),
    };
  }
  if (evidence.operation === "inspect_electron_page") {
    assertEvidenceIdentity(evidence, {
      operation: "inspect_electron_page",
      predicate: "rea.electron-page-inspection",
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
      captureSha256: canonicalDigest(inspection, "Runtime reconciliation"),
      scriptsCompleteWithinScope: scriptsComplete(inspection.completeness),
    };
  }
  if (evidence.operation === "observe_javascript_runtime") {
    assertEvidenceIdentity(evidence, {
      operation: "observe_javascript_runtime",
      predicate: "rea.javascript-runtime-observation",
      providerId: "rea-v8-inspector",
      providerName: "REA passive Node/Electron V8 Inspector provider",
      providerVersion: "1",
      authority: "external-service",
      confidence: "observed",
    });
    const result = javascriptRuntimeObservationSchema.parse(
      evidence.normalized_result,
    );
    assertV8RuntimeParameters(evidence, result);
    const inspection = normalizeV8Inspection(result);
    return {
      kind: "v8-inspector",
      evidence,
      inspection,
      captureSha256: canonicalDigest(result, "Runtime reconciliation"),
      scriptsCompleteWithinScope: false,
    };
  }
  if (evidence.operation === "capture_electron_scenario") {
    return parseActiveElectronCapture(evidence);
  }
  throw new TypeError(
    "Runtime reconciliation requires inspect_web_page, inspect_electron_page, observe_javascript_runtime, or capture_electron_scenario Evidence",
  );
};

const assertV8RuntimeParameters = (
  evidence: Evidence,
  result: JavaScriptRuntimeObservation,
): void => {
  const parameters = z
    .object({
      inspector_endpoint: browserEndpointSchema,
      target_id: z.string().trim().min(1),
      runtime_kind: javascriptRuntimeKindSchema.optional(),
    })
    .passthrough()
    .parse(evidence.parameters);
  if (
    parameters.target_id !== result.target.target_id ||
    (parameters.runtime_kind !== undefined &&
      parameters.runtime_kind !== result.target.runtime_kind)
  )
    throw new TypeError(
      "Runtime Evidence target or declared role disagrees with its result",
    );
  for (const location of [
    result.target.location,
    ...result.scripts.items.map(({ location }) => location),
  ])
    if (location.kind === "builtin" && !location.specifier.startsWith("node:"))
      throw new TypeError(
        "Runtime Evidence contains an invalid builtin location",
      );
};

const normalizeV8Inspection = (
  result: JavaScriptRuntimeObservation,
): NormalizedV8Inspection => ({
  target: {
    target_id: result.target.target_id,
    type: result.target.protocol_type,
    title: result.target.runtime_kind,
    attached: result.target.attached,
    ...(result.target.location.kind === "unresolved"
      ? { unresolved_location: result.target.location }
      : runtimeLocation(result.target.location)),
  },
  frames: [],
  scripts: {
    items: result.scripts.items.map((script) => ({
      script_key: script.script_key,
      frame_id: script.execution_context_key,
      ...runtimeLocation(script.location),
      cdp_hash: script.cdp_hash,
      length: script.length,
      is_module: script.is_module,
      language: null,
      source: {
        included: false,
        reason: "V8 Inspector source capture is outside passive authority.",
      },
    })),
  },
  workers: [],
  completeness: classifyBrowserCompleteness({
    policyFilteredSections: new Set(
      excludedV8Scripts(result) > 0 ? ["scripts"] : [],
    ),
    attachLimitedSections: new Set([
      "frames",
      "scripts",
      "script_sources",
      "workers",
    ]),
    truncatedSections: new Set(result.capture.truncated ? ["scripts"] : []),
    unavailableSections: new Set(["frames", "script_sources", "workers"]),
    excluded:
      excludedV8Scripts(result) === 0
        ? []
        : [
            {
              section: "scripts",
              reason: "out_of_target_scope",
              count: excludedV8Scripts(result),
            },
          ],
    droppedEvents: {
      scripts: result.capture.events_dropped,
      network_requests: 0,
      console_events: 0,
      websocket_connections: 0,
      websocket_frames: 0,
      webmcp_tools: 0,
      timeline_events: 0,
    },
  }),
});

const runtimeLocation = (
  location: JavaScriptRuntimeLocation,
): { readonly file_path: string } | { readonly url: string } => {
  if (location.kind === "file") return { file_path: location.file_path };
  if (location.kind === "url") return { url: location.sanitized_url };
  return { url: location.specifier };
};

const excludedV8Scripts = (result: JavaScriptRuntimeObservation): number =>
  Object.values(result.scripts.excluded).reduce(
    (total, count) => total + count,
    0,
  );

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
    target_id: z.string().trim().min(1),
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
        "Runtime Evidence contains source without source-capture selection",
      );
    return;
  }
  const parameters = z.object(common).passthrough().parse(evidence.parameters);
  if (parameters.target_id !== expected.targetId)
    throw new TypeError(
      "Runtime Evidence target disagrees with its captured result",
    );
  if (expected.sourceIncluded && !parameters.include_script_sources)
    throw new TypeError(
      "Runtime Evidence contains source without source-capture selection",
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
