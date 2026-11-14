import { commandObservationSchema } from "../domain/commandObservation.js";
import { objdumpSummaryViewResultSchema } from "../domain/analysisView/analysisViewResult.js";

import {
  objdumpInputSchema,
  radare2InputSchema,
  radiff2InputSchema,
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
      "Run one caller-selected Rizin command on a local artifact. Commands/plugins can execute code, mutate files, access network and read outside the artifact; those external inputs are not Evidence-bound. Suppresses user settings/scripts but retains plugins. Raw stdout/stderr is authoritative, JSON is command-specific, and UTF-8 loss/truncation is explicit; output-limit termination leaves completion unknown. Rizin exits 0 even when its shell refuses a statement; completion_status rejected marks that refusal, and later statements did not run. Other command failures can still exit 0, so inspect stderr before treating empty output as absence. For raw images, asm_arch/asm_bits/asm_cpu select decoding and base_address maps offset 0; base_address also passes -n to skip loaders even on ELF, without REA confirming either. An admitted command retires shared binary analysis: close Ghidra explicitly first, then open_binary after effects settle. command_timeout_ms is per-phase and max_output_bytes bounds combined output (16 MiB default); both apply next call without restart and do not raise client receive limits or persistent debugger deadlines.",
    inputSchema: rizinInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information",
        input: { path: "/tmp/program", command: "iI" },
      },
    ],
  },
  {
    name: "execute_radare2_command",
    ...toolContractMetadata("execute_radare2_command"),
    kind: "native-provider",
    description:
      "Execute one caller-selected Radare2 command against a local artifact using the Radare2 CLI profile that suppresses user rcfiles while retaining plugins. Preserves decoded stdout and stderr inline with SHA-256 Evidence, up to a shared 16 MiB combined limit; invalid UTF-8 bytes are represented by replacement characters and flagged in Evidence limitations. output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. Radare2 commands and retained plugins can execute foreign code, mutate files, access the network, and read files outside the selected artifact; identities and contents of those external inputs are not bound to Evidence. Command effects depend on the Radare2 command and loaded plugins; JSON is command-specific and raw output remains authoritative. In a shared MCP server, this admitted command closes any active binary-analysis session; after its effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first. Optional command_timeout_ms is the per-phase wall clock in milliseconds (default 120000, range 1..2147483647); omitted means 120000 and the value applies on the next call. It does not raise the 16 MiB output cap.",
    inputSchema: radare2InputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information as JSON",
        input: { path: "/tmp/program", command: "ij" },
      },
    ],
  },
  {
    name: "compare_with_radiff2",
    ...toolContractMetadata("compare_with_radiff2"),
    kind: "native-provider",
    description:
      "Compare two local artifacts with the caller-supplied radiff2 tool. `operation: functions` maps to `-Cj -A` and returns radiff2's function-level diff as JSON in stdout; `operation: bytes` maps to `-A` and returns the byte-level diff text. The comparison is read-only and offers no arbitrary-command surface. Evidence digests cover `path_a` only; `path_b` is preserved as the caller-selected path and its identity is not digest-bound. Preserves decoded stdout and stderr inline, up to a shared 16 MiB combined limit; output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. JSON is radiff2-version-specific and raw output remains authoritative. The comparison neither reads nor alters the active analysis session, so an open target stays usable after it returns. Optional command_timeout_ms is the per-phase wall clock in milliseconds (default 120000, range 1..2147483647); omitted means 120000 and the value applies on the next call. It does not raise the 16 MiB output cap.",
    inputSchema: radiff2InputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Compare function-level differences",
        input: {
          path_a: "/tmp/program-a",
          path_b: "/tmp/program-b",
          operation: "functions",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
