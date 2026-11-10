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
      "Inspect one explicit local V8 code cache container (a bytenode .jsc, the bytes vm.Script.createCachedData writes, or a cache embedded in a Node single-executable application or Electron app) as static bytes, with no child process, no bytenode dependency, and no decompiler. Returns the artifact path/SHA-256/byte length, the eight observed header words each with its role and whether that role is confirmed, inferred, or unconfirmed, the observed magic and the build-stable high half, the producer family, the recorded source length, the payload offset/length/SHA-256, and printable byte sequences inside the payload with absolute byte ranges. Admission is narrow: a header this reader pins, the V8 code cache magic high half, and a payload length that reaches exactly the end of the file; an unknown magic, a short header, or a payload-length disagreement returns a typed failure and never a partial parse. Header field roles other than magic, source length, and payload length are inferred from one producer and are version-dependent, so they are reported as observations rather than a fixed ABI. Embedded strings are byte-pattern observations inside serialized V8 heap data, not parsed heap objects: a reported sequence is not proof V8 retained it as a string and a missing literal is not proof it is absent. The payload is not source; recovering logic needs a version-pinned View8-style decompiler that this tool neither provides nor depends on. Reads a stable regular file; exhausted observation budgets return no partial success. Portable on supported Node hosts; no V8 runtime is required.",
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
