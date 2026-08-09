import { z } from "zod";

import {
  controlledReplayExecutionOutputSchema,
  controlledReplayPlanInputSchema,
  controlledReplayPlanOutputSchema,
} from "./javascriptReplay.js";
import {
  javascriptExportInstrumentationInputSchema,
  javascriptExportTransformationManifestSchema,
} from "./javascriptExportInstrumentation.js";
import { runtimeCharacterizationPlanSchema } from "./runtimeCharacterization.js";
import { evidenceRecordSchema } from "./evidence.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nodeCharacterizationExpectedEffectSchema = z.enum([
  "pure",
  "observation-only",
]);
const nodeRuntimeCharacterizationPlanSchema =
  runtimeCharacterizationPlanSchema.extend({
    expected_effect: nodeCharacterizationExpectedEffectSchema,
  });

export const nodeCharacterizationPreparationInputSchema = z
  .strictObject({
    preparation_approved: z.literal(true),
    selected_alias: z.string().min(1).max(200),
    expected_effect: nodeCharacterizationExpectedEffectSchema,
    instrumentation: javascriptExportInstrumentationInputSchema,
    replay: controlledReplayPlanInputSchema,
  })
  .superRefine((input, context) => {
    const selected = input.replay.left.modules.filter(
      ({ alias }) => alias === input.selected_alias,
    );
    if (
      selected.length !== 1 ||
      selected[0]?.path !== input.instrumentation.artifact_path ||
      selected[0]?.format !== "commonjs-factory"
    )
      context.addIssue({
        code: "custom",
        path: ["selected_alias"],
        message:
          "Selected alias must identify exactly one commonjs-factory instrumented artifact",
      });
    if (input.replay.left.entry_alias !== input.selected_alias)
      context.addIssue({
        code: "custom",
        path: ["replay", "left", "entry_alias"],
        message: "Instrumented alias must be the characterization entry",
      });
    if (
      input.replay.left.entry_export !==
      input.instrumentation.selection.export_name
    )
      context.addIssue({
        code: "custom",
        path: ["replay", "left", "entry_export"],
        message: "Replay entry export must match the instrumented export",
      });
  });

export const nodeCharacterizationExecutionInputSchema = z.strictObject({
  execution_approved: z.literal(true),
  approved_plan_sha256: digestSchema,
  preparation: nodeCharacterizationPreparationInputSchema,
});

export const nodeCharacterizationPreparationOutputSchema = z.strictObject({
  schema_version: z.literal(1),
  phase: z.literal("preparation"),
  plan: nodeRuntimeCharacterizationPlanSchema,
  transformation: javascriptExportTransformationManifestSchema,
  transformation_evidence: evidenceRecordSchema,
  replay: controlledReplayPlanOutputSchema,
});

export const nodeCharacterizationExecutionOutputSchema = z.strictObject({
  schema_version: z.literal(1),
  phase: z.literal("execution"),
  plan: nodeRuntimeCharacterizationPlanSchema,
  transformation: javascriptExportTransformationManifestSchema,
  transformation_evidence: evidenceRecordSchema,
  evidence: evidenceRecordSchema,
  replay: controlledReplayExecutionOutputSchema,
});

export type NodeCharacterizationPreparationInput = z.infer<
  typeof nodeCharacterizationPreparationInputSchema
>;
