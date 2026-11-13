import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeTargetListSchema,
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
} from "../../domain/javascript/javascriptRuntimeObservation.js";

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
        title: "List Node Inspector targets",
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
      "Passively observe loaded-script and execution-context metadata on one loopback Node/Electron V8 Inspector target, selected by inspector_endpoint and target_id. Presence/attachability and file locations are rechecked; verified file paths stay separate from reported URLs, including distinct query/fragment identities. Parse failures are counted separately from malformed events. REA does not read source, evaluate, pause/resume or instrument execution; imports, EventEmitter activity and Electron IPC remain unknown. Use reconcile_javascript_runtime with static application Evidence. The selected endpoint exposes every target it serves to this tool.",
    kind: "runtime-provider",
    inputSchema: observeJavaScriptRuntimeInputSchema,
    outputSchema: evidenceResultOf(javascriptRuntimeObservationSchema),
    examples: [
      {
        title: "Observe one Node runtime",
        input: {
          inspector_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_JAVASCRIPT_RUNTIME_TARGETS",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
