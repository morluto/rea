import { commandObservationSchema } from "../domain/commandObservation.js";
import { objdumpSummaryViewResultSchema } from "../domain/analysisView/analysisView.js";

import {
  objdumpInputSchema,
  rizinInputSchema,
} from "../domain/reverseEngineering.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { analysisDetailOutputSchemaOf } from "./analysisDetail.js";
import { toolContractMetadata } from "./toolEffects.js";

/** Caller-selected GNU objdump and Rizin observations. */
export const REVERSE_ENGINEERING_TOOL_CONTRACTS = [
  {
    name: "inspect_with_objdump",
    ...toolContractMetadata("inspect_with_objdump"),
    kind: "native-provider",
    description:
      "Inspect a local artifact with caller-selected objdump and GNU-style arguments; the executable implementation/version is unverified. operation disassemble optionally scopes to symbol; omission selects all code sections. operation architectures needs no path and captures -i output without establishing artifact support. Returns authoritative stdout/stderr and artifact SHA-256, with lossy UTF-8 and truncation explicit; there is no stable normalized disassembly format. DWARF debug links are off unless follow_debug_links true; external file identities remain unbound. DEBUGINFOD_URLS is cleared to prevent debuginfod requests. Default complete returns Evidence; summary retains it and returns one command observation for later inspect_analysis_view/export via parent_evidence_id. command_timeout_ms bounds each phase; max_output_bytes independently bounds combined output (16 MiB default). Both apply next call without restart; truncation termination leaves completion unknown, and raising output does not raise client receive limits.",
    inputSchema: objdumpInputSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      commandObservationSchema,
      objdumpSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Disassemble code sections",
        input: { path: "/tmp/program", operation: "disassemble" },
      },
      {
        title: "List advertised BFD targets",
        input: { operation: "architectures" },
      },
    ],
  },
  {
    name: "execute_rizin_command",
    ...toolContractMetadata("execute_rizin_command"),
    kind: "native-provider",
    description:
      "Run one caller-selected Rizin command on a local artifact. Commands/plugins can execute code, mutate files, access network and read outside the artifact; those external inputs are not Evidence-bound. Suppresses user settings/scripts but retains plugins. Raw stdout/stderr is authoritative, JSON is command-specific, and UTF-8 loss/truncation is explicit; output-limit termination leaves completion unknown. Before each command REA also runs the selected executable with -v; provider.name/version come from its banner and can name another tool REA_RIZIN_COMMAND selected, such as radare2, or are assumed without an identifying banner (provider_identity). For raw images, asm_arch/asm_bits/asm_cpu select decoding and base_address maps offset 0; base_address also passes -n to skip loaders even on ELF, without REA confirming either. An admitted command retires shared binary analysis: close Ghidra explicitly first, then open_binary after effects settle. command_timeout_ms is per-phase and max_output_bytes bounds combined output (16 MiB default); both apply next call without restart and do not raise client receive limits or persistent debugger deadlines.",
    inputSchema: rizinInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information",
        input: { path: "/tmp/program", command: "iI" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
