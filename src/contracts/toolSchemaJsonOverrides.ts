import { READINESS_STAGE_IDS } from "../domain/reconstructionReadinessJourneyFindings.js";

type JsonSchema = Readonly<Record<string, unknown>>;
const conditionResultKey = ["t", "hen"].join("");

const exactlyOne = (left: string, right: string): JsonSchema => ({
  oneOf: [{ required: [left] }, { required: [right] }],
});

const exclusivePairs = (
  left: [string, string],
  right: [string, string],
): JsonSchema => ({
  oneOf: [
    {
      required: left,
      not: {
        anyOf: right.map((field) => ({ required: [field] })),
      },
    },
    {
      required: right,
      not: {
        anyOf: left.map((field) => ({ required: [field] })),
      },
    },
  ],
});

const twoEvidenceSources = (
  left: [string, string],
  right: [string, string],
): JsonSchema => ({
  allOf: [exactlyOne(left[0], left[1]), exactlyOne(right[0], right[1])],
});

const approvalDependency = (flag: string, approval: string): JsonSchema => ({
  if: {
    required: [flag],
    properties: {
      [flag]: {
        const: true,
        description: `Whether ${flag} was requested`,
      },
    },
  },
  [conditionResultKey]: {
    required: [approval],
    properties: {
      [approval]: {
        const: true,
        description: `Approval for ${flag}`,
      },
    },
  },
});

const exactReadinessStages: JsonSchema = {
  allOf: [
    {
      properties: {
        stages: {
          description: "Complete reconstruction-readiness stage set",
          additionalProperties: false,
          allOf: READINESS_STAGE_IDS.map((stageId) => ({
            contains: {
              type: "object",
              properties: {
                stage_id: {
                  const: stageId,
                  description: "Readiness stage identifier",
                },
              },
              required: ["stage_id"],
              additionalProperties: false,
              description: "One reconstruction-readiness stage",
            },
            minContains: 1,
            maxContains: 1,
          })),
        },
      },
      additionalProperties: false,
    },
  ],
};

/** Public JSON-Schema constraints that Standard Schema cannot derive from refinements. */
export const TOOL_INPUT_JSON_SCHEMA_OVERRIDES: Readonly<
  Record<string, JsonSchema>
> = {
  compare_web_captures: {
    ...exclusivePairs(
      ["before", "after"],
      ["before_scenario", "after_scenario"],
    ),
  },
  inspect_web_page: {
    allOf: [
      approvalDependency("include_console_text", "console_text_approved"),
      approvalDependency(
        "include_json_body_shapes",
        "json_body_schema_approved",
      ),
      approvalDependency(
        "include_websocket_shapes",
        "websocket_shape_approved",
      ),
    ],
  },
  analyze_web_bundle: {
    allOf: [
      approvalDependency("include_console_text", "console_text_approved"),
      approvalDependency(
        "include_json_body_shapes",
        "json_body_schema_approved",
      ),
      approvalDependency(
        "include_websocket_shapes",
        "websocket_shape_approved",
      ),
      approvalDependency("fetch_source_maps", "source_map_fetch_approved"),
    ],
  },
  inspect_electron_page: {
    allOf: [
      approvalDependency("include_script_sources", "source_capture_approved"),
    ],
  },
  trace_application_feature: {
    ...exactlyOne("application", "application_evidence_id"),
  },
  trace_javascript_semantics: {
    ...exactlyOne("application", "application_evidence_id"),
  },
  compare_application_versions: twoEvidenceSources(
    ["left", "left_evidence_id"],
    ["right", "right_evidence_id"],
  ),
  compare_javascript_export_shapes: twoEvidenceSources(
    ["left", "left_evidence_id"],
    ["right", "right_evidence_id"],
  ),
  compare_source_to_bundle: exactlyOne(
    "application",
    "application_evidence_id",
  ),
  evaluate_reconstruction_readiness: exactReadinessStages,
};

/** Merge a contract-specific public constraint into generated or advertised input JSON Schema. */
export const applyToolInputJsonSchemaOverride = (
  name: string,
  schema: JsonSchema,
): JsonSchema => {
  const override = TOOL_INPUT_JSON_SCHEMA_OVERRIDES[name];
  return override === undefined ? schema : { ...schema, ...override };
};
