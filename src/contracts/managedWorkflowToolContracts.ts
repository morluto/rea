import { compareManagedMembersInputSchema } from "../domain/managedMemberComparison.js";
import type { ToolContract } from "./toolContracts.js";
import { managedWorkflowOutputSchemas } from "./toolOutputSchemas.js";
import { MANAGED_MEMBER_COMPARISON_EXAMPLE } from "./managedWorkflowExamples.js";

const comparisonOutputSchema =
  managedWorkflowOutputSchemas.compare_managed_members;
if (comparisonOutputSchema === undefined)
  throw new Error(
    "Missing managed workflow output schema for compare_managed_members",
  );

/** Provider-neutral managed-code workflow contracts. */
export const MANAGED_WORKFLOW_TOOL_CONTRACTS = [
  {
    name: "compare_managed_members",
    description:
      "Compare two authenticated inspect_managed_members Evidence records using unique-only CIL/signature and structural method-shape tiers. Names are reported as observations but are not used as a matching basis; metadata tokens are remapped as build-local coordinates bound to each artifact SHA-256 and MVID.",
    kind: "application",
    inputSchema: compareManagedMembersInputSchema,
    outputSchema: comparisonOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Compare two managed member observations",
        input: MANAGED_MEMBER_COMPARISON_EXAMPLE,
      },
    ],
  },
] as const satisfies readonly ToolContract[];
