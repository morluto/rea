import { z } from "zod";

import {
  webBundleAnalysisSchema,
  webBundleCallSiteSchema,
} from "./webBundleAnalysis.js";
import {
  analysisParameterLimitSchema,
  analysisResultLimitSchema,
} from "./analysisSettingDefinitions.js";
import { javaScriptRouteSourceFactsSchema } from "./javascript/javascriptRouteFacts.js";
import { javaScriptRefusedPhaseSchema } from "./javascript/javascriptSemanticWorkAllowance.js";
import type { AnalysisError } from "./analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "./analysisErrorCore.js";
import { analysisErrorRemediationAction } from "./analysisErrorPresentation.js";

const observationsSchema = z.strictObject({
  edges: webBundleAnalysisSchema.shape.observations.shape.chunks.shape.edges,
  routes: webBundleAnalysisSchema.shape.observations.shape.routes,
  endpoints: webBundleAnalysisSchema.shape.observations.shape.endpoints,
  webmcp_declarations:
    webBundleAnalysisSchema.shape.observations.shape.webmcp_declarations,
  /** Browser requests whose URL argument could not be resolved statically. */
  unresolved_endpoints: z.array(webBundleCallSiteSchema),
});

/**
 * Syntax-level facts for a parsed script whose named phase was refused.
 * Findings that read that phase's facts were not examined.
 */
const refusedScriptFactsSchema = z.strictObject({
  refused_phase: javaScriptRefusedPhaseSchema,
  parse_status: z.enum(["parsed", "recovered"]),
  inferences: webBundleAnalysisSchema.shape.inferences,
});

const semanticLimitSchema = z.strictObject({
  reason: z.string(),
  limit: analysisParameterLimitSchema,
});
export type WebBundleSemanticLimit = z.infer<typeof semanticLimitSchema>;

/** Serializable result for one captured script, suitable for worker transport. */
export const webBundleScriptAnalysisSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("analyzed"),
      script_key: z.string(),
      parse_status: z.enum(["parsed", "recovered", "failed"]),
      visited_ast_nodes: z.number().int().min(0),
      widened_return_references: z.boolean(),
      semantic_limits: z.array(semanticLimitSchema).exactOptional(),
      route_facts: javaScriptRouteSourceFactsSchema.nullable().optional(),
      observations: observationsSchema,
      inferences: webBundleAnalysisSchema.shape.inferences,
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      script_key: z.string(),
      reason: z.enum([
        "worker_failure",
        "deadline",
        "resource_constraint",
        "cancelled",
        "not_started",
      ]),
      detail: z.string().optional(),
      /** The setting or request parameter that bounded this script. */
      limit: analysisResultLimitSchema.exactOptional(),
      remediation: z.string().exactOptional(),
      /** Facts gathered before a work allowance refused a later phase. */
      partial: refusedScriptFactsSchema.exactOptional(),
    }),
  ])
  .superRefine((result, context) => {
    const checkScriptKey = (
      scriptKey: string,
      path: (string | number)[],
    ): void => {
      if (scriptKey !== result.script_key)
        context.addIssue({
          code: "custom",
          path,
          message: "Per-script analysis evidence must name its owning script",
        });
    };
    const checkInferences = (
      inferences: z.output<typeof refusedScriptFactsSchema>["inferences"],
      path: (string | number)[],
    ): void =>
      inferences.forEach((inference, inferenceIndex) =>
        inference.basis.forEach((basis, basisIndex) =>
          checkScriptKey(basis.script_key, [
            ...path,
            inferenceIndex,
            "basis",
            basisIndex,
            "script_key",
          ]),
        ),
      );

    if (result.status === "unavailable") {
      if (result.partial === undefined) return;
      if (result.reason !== "resource_constraint")
        context.addIssue({
          code: "custom",
          path: ["partial"],
          message: "Only a refused script carries partial facts",
        });
      checkInferences(result.partial.inferences, ["partial", "inferences"]);
      return;
    }

    result.observations.edges.forEach((edge, index) => {
      checkScriptKey(edge.from_script_key, [
        "observations",
        "edges",
        index,
        "from_script_key",
      ]);
      checkScriptKey(edge.location.script_key, [
        "observations",
        "edges",
        index,
        "location",
        "script_key",
      ]);
    });
    for (const collection of [
      "routes",
      "endpoints",
      "unresolved_endpoints",
    ] as const)
      result.observations[collection].forEach((finding, index) =>
        checkScriptKey(finding.location.script_key, [
          "observations",
          collection,
          index,
          "location",
          "script_key",
        ]),
      );
    result.observations.webmcp_declarations.forEach((declaration, index) =>
      checkScriptKey(declaration.location.script_key, [
        "observations",
        "webmcp_declarations",
        index,
        "location",
        "script_key",
      ]),
    );
    checkInferences(result.inferences, ["inferences"]);

    if (result.parse_status === "failed") {
      const hasFindings =
        (result.semantic_limits !== undefined &&
          result.semantic_limits.length > 0) ||
        result.observations.edges.length > 0 ||
        result.observations.routes.length > 0 ||
        result.observations.endpoints.length > 0 ||
        result.observations.unresolved_endpoints.length > 0 ||
        result.observations.webmcp_declarations.length > 0 ||
        result.inferences.length > 0;
      if (
        result.visited_ast_nodes !== 0 ||
        result.widened_return_references ||
        hasFindings
      )
        context.addIssue({
          code: "custom",
          path: ["parse_status"],
          message:
            "A failed script parse cannot carry visited nodes or derived findings",
        });
    }
  });

export type WebBundleScriptAnalysis = z.infer<
  typeof webBundleScriptAnalysisSchema
>;

type UnavailableWebScriptAnalysis = Extract<
  WebBundleScriptAnalysis,
  { readonly status: "unavailable" }
>;

/**
 * The control a script result can record: a registered setting, or a request
 * parameter named by its contract field. An environment control is not a
 * result-side reference, so its error keeps only the detail.
 */
const recordedLimit = (
  limit: AnalysisError["limit"],
): UnavailableWebScriptAnalysis["limit"] =>
  limit === undefined
    ? undefined
    : "setting" in limit
      ? limit
      : limit.control_kind === "parameter"
        ? limit
        : undefined;

/**
 * The detail and structured recovery an unavailable script states for the
 * error that stopped its analysis, such as a resource refusal or a per-script
 * deadline.
 */
export const unavailableWebScriptRecovery = (
  error: AnalysisError,
): Pick<UnavailableWebScriptAnalysis, "detail" | "limit" | "remediation"> => {
  const limit = recordedLimit(error.limit);
  return {
    detail:
      error instanceof AnalysisResourceConstraintError &&
      error.reportedLimits !== null
        ? `${error.userMessage ?? error.reason} Reported limits: ${JSON.stringify(error.reportedLimits)}`
        : (error.userMessage ?? error.message),
    ...(limit === undefined
      ? {}
      : {
          limit,
          remediation: analysisErrorRemediationAction(error),
        }),
  };
};
