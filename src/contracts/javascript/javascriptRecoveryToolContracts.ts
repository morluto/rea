import {
  javascriptRecoveryInputSchema,
  javascriptRecoveryResultSchema,
} from "../../domain/javascript/javascriptRecovery.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";

/** Derived script artifacts from optional upstream recovery adapters. */
export const JAVASCRIPT_RECOVERY_TOOL_CONTRACTS = [
  {
    name: "recover_javascript_sources",
    ...toolContractMetadata("recover_javascript_sources"),
    kind: "application",
    description:
      "Recover readable modules from local UTF-8 JavaScript bundles into an absent output_directory, without executing application code. Requires caller-supplied Wakaru ^1.13.0 (verified 1.14.0), Linux x64 and util-linux prlimit. additional_paths includes related chunks, preserving each input’s snapshot/provenance. Returns original/derived digests, extraction ranges, source maps, warnings and analysis_input for analyze_javascript_application. Splitting may fall back to one module; original names and runtime equivalence remain unknown. One worker has a fixed 120-second deadline and bounded input/output/report admission; limit failures are explicit and roll back output.",
    inputSchema: javascriptRecoveryInputSchema,
    outputSchema: evidenceResultOf(javascriptRecoveryResultSchema),
    examples: [
      {
        title: "Recover a captured production bundle",
        input: {
          path: "/tmp/web-scripts/app.js",
          output_directory: "/tmp/recovered-app",
        },
      },
      {
        title: "Recover a code-split bundle together",
        input: {
          path: "/tmp/web-scripts/main.js",
          additional_paths: [
            "/tmp/web-scripts/runtime.js",
            "/tmp/web-scripts/shared.js",
            "/tmp/web-scripts/checkout.chunk.js",
          ],
          output_directory: "/tmp/recovered-chunks",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
