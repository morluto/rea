import { expect, it } from "vitest";

import { TOOL_CONTRACTS } from "./toolContracts.js";
import { toolOutputSchemaWithMetadata } from "./toolSchemaMetadata.js";

// MCP 2025 output roots are objects. The stdio server registers recorded
// advertisements, so a non-object root would be wrapped there alone and its
// structured results would fail validating clients (#8304).
it.each(["draft-2020-12", "draft-07"] as const)(
  "advertises an object output root for every tool in %s",
  (target) => {
    const nonObject = TOOL_CONTRACTS.filter(
      (contract) =>
        toolOutputSchemaWithMetadata(contract)["~standard"].jsonSchema.output({
          target,
        }).type !== "object",
    ).map(({ name }) => name);
    expect(nonObject).toEqual([]);
  },
);
