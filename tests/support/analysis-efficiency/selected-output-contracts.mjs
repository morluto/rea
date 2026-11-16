import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Output contracts of the revision under test, not the harness checkout's.
 * Revisions with the canonical helper validate against their compiled
 * contracts; earlier revisions list complete output schemas only under the
 * full output profile, so the runner requests it for them.
 */
export const selectedOutputContracts = async (repo) => {
  const helper = join(repo, "scripts/lib/canonical-output-schema.mjs");
  if (existsSync(helper)) {
    const { withCanonicalOutputSchema } = await import(
      pathToFileURL(helper).href
    );
    return { environment: {}, withCanonicalOutputSchema };
  }
  return {
    environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "full" },
    withCanonicalOutputSchema: (tool) => {
      assert.ok(tool.outputSchema, `${tool.name} lists no output schema`);
      return tool;
    },
  };
};
