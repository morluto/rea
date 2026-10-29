import { z } from "zod";
import { jsonRecordSchema } from "../jsonRecord.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { AnalysisUnsupportedTargetError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import { EnvironmentManifestAccumulator } from "./EnvironmentManifestAccumulator.js";
import {
  TEMPLATE_RULES,
  type TemplateRule,
} from "./environmentManifestRules.js";
import { admitHarCaptureParent } from "./WebNetworkProjectionAccumulator.js";
import {
  admitScenarioCaptureParent,
  type ScenarioResponseBodyRetention,
} from "./scenarioCaptureRecords.js";
import { ROUTE_RULES } from "./webNetworkRouteTemplates.js";

/** Opt-in template rules, each listed at most once; shared by every view that groups tools. */
export const templateRulesSchema = z
  .array(z.enum(TEMPLATE_RULES))
  .refine((rules) => new Set(rules).size === rules.length, {
    message: "template_rules must not repeat a rule",
  })
  .meta({ uniqueItems: true })
  .default([]);

export const environmentManifestViewRequestSchema = z.strictObject({
  kind: z.literal("environment-manifest"),
  template_rules: templateRulesSchema.describe(
    "Opt-in template rules applied after the four format rules, each listed at most once: after-uid-literal templates the segment following a literal uid, opaque-token templates long mixed alphanumeric segments, sibling-variance merges groups that differ in one identifier-like segment, sibling-pair-variance merges groups that differ in two adjacent literals between a plural literal and another literal when at least three distinct pairs vary in both, prefix-variance templates a literal at a position another tool templates by one of the other opt-in rules after the same preceding segments, at any method or length, when the literal is one of that parameter's observed values, carries a digit and has the length and character classes of one, or has the single length (eight or more characters) every observed value has and only their character classes. Literal sibling folding into existing opt-in parameters also requires sibling-variance. Merged parameters are inferences.",
  ),
  include_query_parameter_names: z
    .boolean()
    .default(true)
    .describe(
      "Include distinct observed query parameter names per tool; names do not establish required parameters or a complete API schema.",
    ),
});

const manifestRuleSchema = z.enum([...ROUTE_RULES, ...TEMPLATE_RULES]);
const jsonTypeNameSchema = z.enum([
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
]);
const toolSchema = z.strictObject({
  name: z.string(),
  method: z.string(),
  path_template: z.string(),
  api_surface_template: z
    .string()
    .describe("Four-rule template of the tool's earliest record."),
  params: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      name: z.string(),
      rule: manifestRuleSchema,
      basis: z.literal("inferred"),
      observed_values: z.array(z.string()),
    }),
  ),
  query_parameter_names: z.array(z.string()),
  body_shape: z
    .strictObject({
      type: z.literal("object"),
      properties: jsonRecordSchema(jsonTypeNameSchema),
    })
    .nullable(),
  statuses: z.array(z.number()),
  content_types: z.array(z.string()),
  record_ordinals: z.array(z.number().int().nonnegative()),
});
export const environmentManifestFields = {
  origin: z
    .string()
    .describe("Primary origin: the origin with the most JSON-like records."),
  name: z
    .string()
    .describe(
      "Kebab-case environment name derived from the primary origin host.",
    ),
  tools: z.array(toolSchema),
  records: z
    .array(
      z.strictObject({
        ordinal: z.number().int().nonnegative(),
        method: z.string(),
        path: z.string(),
        status: z.number().nullable(),
        content_type: z.string().nullable(),
      }),
    )
    .describe(
      "Pointers to the retained parent records cited by tools; no bodies.",
    ),
  excluded: z.array(
    z.strictObject({
      method: z.string(),
      origin: z.string(),
      path_template: z.string(),
      reason: z.enum(["other-origin", "ui-page-or-asset", "non-json"]),
    }),
  ),
  unknowns: z.array(
    z.strictObject({
      kind: z.enum([
        "authorization-model",
        "response-semantics",
        "state-transition",
      ]),
      statement: z.string(),
    }),
  ),
  templated_groups: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Tools and excluded groups that carry at least one templated segment.",
    ),
};

/** The records, coverage and identity a manifest projects from, for either parent kind. */
export interface CaptureParent {
  readonly operation:
    | "inspect_web_network_capture"
    | "capture_browser_scenario";
  readonly records: readonly WebNetworkCaptureRecord[];
  readonly total_records: number;
  readonly scenarioResponseBodies?: ReadonlyMap<
    number,
    ScenarioResponseBodyRetention
  >;
  readonly limitations: readonly string[];
  readonly artifact: { readonly path: string; readonly sha256: string | null };
}

/** HAR captures keep their own gate; a browser scenario has no captured file, so its artifact is empty. */
const admitCaptureParent = (
  parent: AnalysisViewParent,
  viewKind: "environment-manifest" | "environment-state",
  accumulator: EnvironmentManifestAccumulator,
): Result<CaptureParent, AnalysisError> => {
  if (parent.operation === "capture_browser_scenario") {
    const scenario = admitScenarioCaptureParent(parent, viewKind, accumulator);
    return scenario.ok
      ? ok({
          operation: "capture_browser_scenario",
          records: scenario.value.records,
          total_records: scenario.value.totalRecords,
          scenarioResponseBodies: scenario.value.responseBodies,
          limitations: scenario.value.limitations,
          artifact: { path: "", sha256: null },
        })
      : scenario;
  }
  const har = admitHarCaptureParent(parent, viewKind, accumulator);
  return har.ok
    ? ok({ operation: "inspect_web_network_capture", ...har.value })
    : har;
};

/** Admit the parent, the shared and view-specific limitations, then group every retained record. */
export const groupCaptureRecords = (
  parent: AnalysisViewParent,
  viewKind: "environment-manifest" | "environment-state",
  rules: readonly TemplateRule[],
  target: {
    readonly accumulator: EnvironmentManifestAccumulator;
    readonly noun: "manifest" | "state";
    readonly limitations: readonly string[];
  },
): Result<CaptureParent, AnalysisError> => {
  const admitted = admitCaptureParent(parent, viewKind, target.accumulator);
  if (!admitted.ok) return admitted;
  const added = addCaptureRecords(parent, admitted.value, rules, target);
  return added.ok ? admitted : added;
};

/** Admit the shared and view-specific limitations, then group every retained record. */
const addCaptureRecords = (
  parent: AnalysisViewParent,
  capture: CaptureParent,
  rules: readonly TemplateRule[],
  target: {
    readonly accumulator: EnvironmentManifestAccumulator;
    readonly noun: "manifest" | "state";
    readonly limitations: readonly string[];
  },
): Result<void, AnalysisError> => {
  const limitations = target.accumulator.addLimitations([
    ...parent.limitations,
    ...capture.limitations,
    "Tool templates, parameters and names are inferences from recorded request lines; they do not establish handler identity, URL-space schemas or causality.",
    ...target.limitations,
    ...(rules.length > 0
      ? [
          `Opt-in template rules ${uniqueSorted(rules).join(", ")} merge recorded literals by shape; merged parameters may conflate distinct resources.`,
        ]
      : []),
    ...(capture.records.length < capture.total_records
      ? [
          `Parent contains an ordinal subset; the ${target.noun} covers only retained records.`,
        ]
      : []),
  ]);
  if (!limitations.ok) return limitations;
  for (const record of capture.records) {
    const added = target.accumulator.add(
      record,
      capture.scenarioResponseBodies?.get(record.ordinal),
    );
    if (!added.ok) return added;
  }
  return ok(undefined);
};

/** Create the manifest budget with its selected query names and template rules. */
export const createEnvironmentManifestAccumulator = (
  view: AnalysisViewRequest,
): EnvironmentManifestAccumulator =>
  view.kind === "environment-manifest"
    ? new EnvironmentManifestAccumulator(
        undefined,
        view.include_query_parameter_names,
        view.template_rules,
      )
    : new EnvironmentManifestAccumulator();

/** Project retained request lines, from a HAR or a browser scenario, into a replayable tool surface; templates are inferences. */
export const projectEnvironmentManifestView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
  accumulator = createEnvironmentManifestAccumulator(view),
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "environment-manifest")
    return err(
      new AnalysisUnsupportedTargetError(
        "inspect_analysis_view",
        parent.evidenceId,
        `View ${view.kind} is unsupported for parent operation ${parent.operation}; environment-manifest requires inspect_web_network_capture or capture_browser_scenario.`,
      ),
    );
  const grouped = groupCaptureRecords(parent, view.kind, view.template_rules, {
    accumulator,
    noun: "manifest",
    limitations: view.include_query_parameter_names
      ? [
          "Observed query parameter names do not establish required parameters, value types or a complete API schema.",
        ]
      : [],
  });
  if (!grouped.ok) return grouped;
  const capture = grouped.value;
  const manifest = accumulator.finish();
  if (!manifest.ok) return manifest;
  return ok({
    kind: "environment-manifest",
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: capture.operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: capture.artifact.path, sha256: capture.artifact.sha256 },
    ...manifest.value,
  });
};
