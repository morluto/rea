import { z } from "zod";

import { androidApplicationOutputSchemas } from "./toolOutputSchemas.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Session references for one bounded Android application projection. */
export const androidApplicationReferenceInputSchema = z.strictObject({
  inventory_evidence_ids: z
    .array(z.string().regex(/^ev_[a-f0-9]{64}$/u))
    .min(1)
    .max(100),
  limits: z
    .strictObject({
      max_components: z.number().int().min(1).max(10_000).default(1_000),
    })
    .default({ max_components: 1_000 }),
});

const outputSchema =
  androidApplicationOutputSchemas.project_android_application_graph;
if (outputSchema === undefined)
  throw new Error("Missing Android application graph output schema");

/** Provider-neutral Android application workflow contract. */
export const ANDROID_APPLICATION_TOOL_CONTRACTS = [
  {
    name: "project_android_application_graph",
    ...toolContractMetadata("project_android_application_graph"),
    description:
      "Project authenticated, bounded APK inventory Evidence into deterministic Android components, runtime-family observations, and explicit managed-to-native bridge hypotheses. Reports exact artifact paths and hashes without executing code or decoding Android binary formats.",
    kind: "application",
    inputSchema: androidApplicationReferenceInputSchema,
    outputSchema,
    examples: [
      {
        title: "Project an APK inventory into Android application components",
        input: {
          inventory_evidence_ids: [`ev_${"1".repeat(64)}`],
          limits: { max_components: 1_000 },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
