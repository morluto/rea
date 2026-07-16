import { z } from "zod";

import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "./javascriptReplay.js";
import {
  javascriptExportInstrumentationInputSchema,
  javascriptExportTransformationManifestSchema,
} from "./javascriptExportInstrumentation.js";
import { runtimeCharacterizationPlanSchema } from "./runtimeCharacterization.js";
import { evidenceRecordSchema } from "./evidence.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const nodeCharacterizationPreparationInputSchema = z
  .strictObject({
    preparation_approved: z.literal(true),
    selected_alias: z.string().min(1).max(200),
    expected_effect: z.enum(["pure", "observation-only"]),
    instrumentation: javascriptExportInstrumentationInputSchema,
    replay: controlledReplayInputSchema,
  })
  .superRefine((input, context) => {
    if (input.replay.mode !== "plan")
      context.addIssue({
        code: "custom",
        path: ["replay", "mode"],
        message: "Characterization preparation requires replay plan mode",
      });
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
  plan: runtimeCharacterizationPlanSchema,
  transformation: javascriptExportTransformationManifestSchema,
  transformation_evidence: evidenceRecordSchema,
  replay: controlledReplayOutputSchema,
});

export const nodeCharacterizationExecutionOutputSchema = z.strictObject({
  schema_version: z.literal(1),
  phase: z.literal("execution"),
  plan: runtimeCharacterizationPlanSchema,
  transformation: javascriptExportTransformationManifestSchema,
  transformation_evidence: evidenceRecordSchema,
  evidence: evidenceRecordSchema,
  replay: controlledReplayOutputSchema,
});

export type NodeCharacterizationPreparationInput = z.infer<
  typeof nodeCharacterizationPreparationInputSchema
>;
