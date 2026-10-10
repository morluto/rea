import {
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static Go metadata is independent of active native-analysis providers and host toolchains. */
export const GO_TOOL_CONTRACTS = [
  {
    name: "inspect_go_binary",
    ...toolContractMetadata("inspect_go_binary"),
    kind: "artifact-provider",
    description:
      "Inspect embedded Go compiler version, main module, dependency/replacement versions and build settings in an explicit local ELF, PE or thin Mach-O image. Returns original artifact SHA-256, exact build-info source ranges, raw framed module bytes and unparsed module-text lines inline as observed Evidence. Supports inline and historical pointer encodings without installing Go, opening a disassembler, executing the target, writing temporary files or accessing the network. Missing metadata is reported as unknown, not proof that an image is not Go. Does not recover functions, source mappings, types or runtime behavior. Resource guards bound files to 256 MiB, aggregate embedded strings to 1 MiB, structural table decoding to 16 MiB and complete inline metadata to 8 MiB; malformed, unsupported and oversized inputs receive typed failures rather than partial success.",
    inputSchema: inspectGoBinaryInputSchema,
    outputSchema: evidenceResultOf(goBinarySchema),
    examples: [
      {
        title: "Inspect embedded build provenance",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
