import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { nativeOutputSchemas } from "./toolOutputSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";

const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inspect_macho: {},
  inspect_signature: {},
  inspect_plist: { relative_path: "Contents/Info.plist" },
  list_architectures: {},
  demangle_swift: { symbols: ["$s4Test3fooyyF"] },
};

const native = <Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
): ToolContract<Name> => {
  const outputSchema = nativeOutputSchemas[name];
  if (outputSchema === undefined)
    throw new Error(`Missing native output schema for ${name}`);
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "native-provider",
    inputSchema,
    outputSchema,
    examples: [
      {
        title: `Example ${name.replaceAll("_", " ")} request`,
        input: z
          .record(z.string(), jsonValueSchema)
          .parse(examples[name] ?? {}),
      },
    ],
  };
};

/** Provider-neutral semantic operations backed initially by macOS utilities. */
export const NATIVE_TOOL_CONTRACTS = [
  native(
    "inspect_macho",
    "Inspect Mach-O slices, load commands, imports, exports, dependencies, build metadata, segments, sections, permissions, and exact command provenance without launching Hopper.",
    z.object({}),
  ),
  native(
    "inspect_signature",
    "Inspect the active artifact's code-signing identity, hashes, authorities, requirements, entitlements, hardened-runtime state, and bounded command provenance.",
    z.object({}),
  ),
  native(
    "inspect_plist",
    "Parse a plist at a bounded relative path beneath the active artifact container. Symlink and traversal escapes are rejected; output is normalized JSON rather than plutil text.",
    z.object({
      relative_path: z
        .string()
        .min(1)
        .max(1_024)
        .default("Contents/Info.plist"),
    }),
  ),
  native(
    "list_architectures",
    "List thin or universal Mach-O slices with offsets, sizes, alignment, explicit coverage, and bounded native-tool provenance.",
    z.object({}),
  ),
  native(
    "demangle_swift",
    "Demangle an ordered bounded batch of Swift symbols without requiring Hopper. Each input returns demangled, unchanged, or invalid status.",
    z.object({
      symbols: z.array(z.string().min(1).max(4_096)).min(1).max(500),
    }),
  ),
] as const satisfies readonly ToolContract[];

export type NativeToolName = (typeof NATIVE_TOOL_CONTRACTS)[number]["name"];
