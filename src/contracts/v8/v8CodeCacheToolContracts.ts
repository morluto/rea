import {
  inspectV8CodeCacheInputSchema,
  v8CodeCacheSchema,
} from "../../domain/v8/v8CodeCache.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Static V8 code cache inspection is independent of active native-analysis providers. */
export const V8_CODE_CACHE_TOOL_CONTRACTS = [
  {
    name: "inspect_v8_code_cache",
    ...toolContractMetadata("inspect_v8_code_cache"),
    kind: "artifact-provider",
    description:
      "Inspect a local bytenode .jsc or compatible V8 code-cache container as static bytes, without V8, bytenode, child processes or decompilation. Returns artifact identity, header words with confirmed/inferred roles, producer family, recorded source length, payload identity and printable sequences with file ranges. Only pinned header/magic and exact payload-length layouts are admitted; unknown or malformed layouts fail, not partial-parse. Most header roles are version-dependent inferences, not a fixed ABI. Payload strings are byte patterns, not parsed heap objects; missing literals do not prove absence. The payload is not source: logic recovery needs a separate version-pinned decompiler. Resource refusals remain explicit.",
    inputSchema: inspectV8CodeCacheInputSchema,
    outputSchema: evidenceResultOf(v8CodeCacheSchema),
    examples: [
      {
        title: "Identify the V8 producer of a bytenode code cache",
        input: { path: "/artifacts/module.jsc" },
      },
      {
        title: "Locate retained config keys in the payload",
        input: {
          path: "/artifacts/module.jsc",
          min_string_bytes: 8,
          max_strings: 256,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
