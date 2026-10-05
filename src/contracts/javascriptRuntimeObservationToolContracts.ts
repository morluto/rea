import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeTargetListSchema,
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
} from "../domain/javascriptRuntimeObservation.js";

const endpoint = "http://127.0.0.1:9229";

/** Passive Node/Electron V8 Inspector discovery and observation contracts. */
export const JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS = [
  {
    name: "list_javascript_runtime_targets",
    ...toolContractMetadata("list_javascript_runtime_targets"),
    description:
      "List every eligible Node/Electron V8 Inspector target from an explicit literal-loopback endpoint. Node discovery file locations that cannot be verified are preserved as unresolved reported URLs; they do not prove filesystem identity. Listing does not attach to targets.",
    kind: "runtime-provider",
    inputSchema: listJavaScriptRuntimeTargetsInputSchema,
    outputSchema: evidenceResultOf(javascriptRuntimeTargetListSchema),
    examples: [
      {
        title: "List approved Node Inspector targets",
        input: {
          inspector_endpoint: endpoint,
        },
      },
    ],
  },
  {
    name: "observe_javascript_runtime",
    ...toolContractMetadata("observe_javascript_runtime"),
    description:
      "Attach passively to one Node/Electron V8 Inspector target by supplying its loopback Inspector endpoint and target ID. The provider rechecks target presence and attachability; a Node discovery file location may remain unresolved. Loaded script locations are validated independently from Debugger.scriptParsed. Captures script and Runtime execution-context metadata. REA never evaluates, pauses, resumes, reads source, or instruments the target; require/import edges, EventEmitter activity, and Electron IPC remain explicit unknowns. Reconcile the result with static Application Graph Evidence using reconcile_javascript_runtime. The selected endpoint exposes every target it serves to this tool.",
    kind: "runtime-provider",
    inputSchema: observeJavaScriptRuntimeInputSchema,
    outputSchema: evidenceResultOf(javascriptRuntimeObservationSchema),
    examples: [
      {
        title: "Observe one approved Node runtime",
        input: {
          inspector_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_JAVASCRIPT_RUNTIME_TARGETS",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
