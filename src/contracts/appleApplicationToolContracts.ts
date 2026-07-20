import { z } from "zod";

import { appleApplicationOutputSchemas } from "./toolOutputSchemas.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Session references for one bounded Apple application projection. */
export const appleApplicationReferenceInputSchema = z.strictObject({
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
  appleApplicationOutputSchemas.project_apple_application_graph;
if (outputSchema === undefined)
  throw new Error("Missing Apple application graph output schema");

/** Provider-neutral Apple application workflow contract. */
export const APPLE_APPLICATION_TOOL_CONTRACTS = [
  {
    name: "project_apple_application_graph",
    ...toolContractMetadata("project_apple_application_graph"),
    description:
      "Project authenticated, bounded IPA inventory Evidence into deterministic Apple application components, runtime-family observations, and explicit cross-language bridge hypotheses. Reports exact artifact paths and hashes without executing code or parsing provisioning-profile signing material.",
    kind: "application",
    inputSchema: appleApplicationReferenceInputSchema,
    outputSchema,
    examples: [
      {
        title: "Project an IPA inventory into Apple application components",
        input: {
          inventory_evidence_ids: [`ev_${"1".repeat(64)}`],
          limits: { max_components: 1_000 },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
