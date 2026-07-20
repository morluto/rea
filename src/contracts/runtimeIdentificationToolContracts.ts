import { z } from "zod";

import { runtimeIdentificationOutputSchemas } from "./toolOutputSchemas.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Session Evidence references accepted by runtime identification. */
export const runtimeIdentificationReferenceInputSchema = z.strictObject({
  inventory_evidence_ids: z
    .array(z.string().regex(/^ev_[a-f0-9]{64}$/u))
    .min(1)
    .max(100),
  limits: z
    .strictObject({
      max_observations: z.number().int().min(1).max(10_000).default(1_000),
    })
    .default({ max_observations: 1_000 }),
});

const outputSchema = runtimeIdentificationOutputSchemas.identify_runtime;
if (outputSchema === undefined)
  throw new Error("Missing runtime-identification output schema");

/** Provider-neutral runtime-identification tool contract. */
export const RUNTIME_IDENTIFICATION_TOOL_CONTRACTS = [
  {
    name: "identify_runtime",
    ...toolContractMetadata("identify_runtime"),
    description:
      "Identify runtime families from authenticated artifact inventory Evidence and report whether semantic tooling is available, missing, or requires provider selection. This classifies exact formats and paths without executing or decoding target bytecode.",
    inputSchema: runtimeIdentificationReferenceInputSchema,
    outputSchema,
    kind: "application",
    examples: [
      {
        title: "Identify runtimes in an artifact inventory",
        input: {
          inventory_evidence_ids: [`ev_${"1".repeat(64)}`],
          limits: { max_observations: 1_000 },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
