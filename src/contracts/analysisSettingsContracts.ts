import { analysisErrorProjectionSchema } from "../domain/analysisErrorProjectionSchema.js";
import { z } from "zod";
import {
  analysisSettingIds,
  analysisSettingIdSchema,
  analysisSettingValueSchema,
} from "../domain/analysisSettingDefinitions.js";
import { toolContractMetadata, toolEffects } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

export const inspectAnalysisSettingsInputSchema = z.strictObject({
  settings: z
    .array(analysisSettingIdSchema)
    .max(analysisSettingIds.length)
    .optional(),
  operation: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
});
const [firstSetSettingChangeSchema, ...otherSetSettingChangeSchemas] =
  analysisSettingIds.map((setting) =>
    z.strictObject({
      setting: z.literal(setting),
      action: z.literal("set"),
      value: analysisSettingValueSchema(setting),
    }),
  );
if (firstSetSettingChangeSchema === undefined)
  throw new Error("Analysis settings registry must not be empty");
const setSettingChangeSchemas = [
  firstSetSettingChangeSchema,
  ...otherSetSettingChangeSchemas,
] as const;
const resetSettingChangeSchema = z.strictObject({
  setting: analysisSettingIdSchema,
  action: z.literal("reset"),
});
const settingChangeSchema = z.discriminatedUnion("action", [
  z.discriminatedUnion("setting", setSettingChangeSchemas),
  resetSettingChangeSchema,
]);
// Keep canonical JSON Schema flat so advertised input stays within the 10-level depth cap.
const flatSettingChangeUnion = z.union([
  ...setSettingChangeSchemas,
  resetSettingChangeSchema,
]);
settingChangeSchema._zod.toJSONSchema = () => {
  const { $schema: _schema, ...schema } = z.toJSONSchema(
    flatSettingChangeUnion,
    { target: "draft-2020-12", io: "input", reused: "inline" },
  );
  return schema;
};

export const updateAnalysisSettingsInputSchema = z.strictObject({
  changes: z.array(settingChangeSchema).min(1).max(analysisSettingIds.length),
  expected_revision: z.number().int().nonnegative().optional(),
});
const descriptor = z.strictObject({
  setting: analysisSettingIdSchema,
  value: z.number().nullable().optional(),
  launch_value: z.number().nullable().optional(),
  default_value: z.number().nullable(),
  source: z.enum(["default", "setting", "runtime", "invalid"]),
  configuration_error: analysisErrorProjectionSchema.optional(),
  unit: z.enum(["bytes", "ms", "seconds", "MiB", "count"]),
  minimum: z.number(),
  maximum: z.number(),
  applies_at: z.enum(["next_operation", "next_worker", "next_startup"]),
  update_mode: z.enum(["runtime", "restart"]),
  pending_restart: z
    .boolean()
    .optional()
    .describe(
      "Whether an accepted configuration is waiting for restart. Omitted when the launch value is invalid and there is no accepted runtime override.",
    ),
  provider: z.string(),
  operations: z.array(z.string()),
  environment: z.string().optional(),
  parameter: z.string().optional(),
  agent_editable: z.literal(true),
});
export const analysisSettingsResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  scope: z.literal("rea-runtime"),
  active_values: z.strictObject({ status: z.literal("not_observed") }),
  settings: z.array(descriptor),
  constraints: z
    .array(
      z.strictObject({
        control: z.string(),
        authority: z.enum(["operator", "external", "fixed"]),
        value: z.number().nullable(),
        unit: z.string(),
        observation: z.enum(["known", "unknown"]),
        recovery: z.string(),
      }),
    )
    .optional(),
});
export const updateAnalysisSettingsResultSchema =
  analysisSettingsResultSchema.extend({
    changed: z.boolean(),
    changes: z.array(
      z.strictObject({
        setting: analysisSettingIdSchema,
        old_value: z.number().nullable().optional(),
        new_value: z.number().nullable().optional(),
      }),
    ),
    active_work_changed: z.literal(false),
    pending_restart: z.literal(false),
  });
export const ANALYSIS_SETTINGS_TOOL_CONTRACTS = [
  {
    name: "inspect_analysis_settings",
    ...toolContractMetadata("inspect_analysis_settings", toolEffects()),
    kind: "application",
    description:
      "Inspect REA's editable runtime admission sizes, deadlines and worker heaps, their bounds, launch values and application points. No active target is required. Filters intersect. If an error already names a setting and its bounds, update_analysis_settings can be called directly. Explicit per-call arguments override runtime defaults. Active worker values are not observed by this configuration view.",
    inputSchema: inspectAnalysisSettingsInputSchema,
    outputSchema: analysisSettingsResultSchema,
    examples: [
      {
        title: "Inspect archive header admission",
        input: { settings: ["asar.max_header_bytes"] },
      },
    ],
  },
  {
    name: "update_analysis_settings",
    ...toolContractMetadata(
      "update_analysis_settings",
      toolEffects({ mutatesSession: true }),
    ),
    kind: "application",
    description:
      "Atomically set or reset editable runtime defaults for new work. Changes survive target close/open but disappear on REA restart; reset restores launch configuration. Follow an error's named setting/bounds directly, then retry after work and cleanup settle; no inspection is needed when they are supplied. Does not change active work, edit files, restart providers, raise client limits or override explicit per-call arguments.",
    inputSchema: updateAnalysisSettingsInputSchema,
    outputSchema: updateAnalysisSettingsResultSchema,
    examples: [
      {
        title: "Raise ASAR header admission for a retry",
        input: {
          changes: [
            {
              setting: "asar.max_header_bytes",
              action: "set",
              value: 33554432,
            },
          ],
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
