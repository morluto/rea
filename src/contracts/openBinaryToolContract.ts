import { z } from "zod";
import { liveBinaryTargetSummaryVariants } from "../domain/liveBinaryTargetSummary.js";
import { openBinaryInputSchema } from "./sessionLifecycleInputs.js";
import { examplesFor } from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata, toolEffects } from "./toolEffects.js";
import { lifecycleResultOf } from "./toolOutputSchemaPrimitives.js";

/** Exact structured-content schema for `open_binary`. */
export const openBinaryOutputSchema = lifecycleResultOf(
  z.discriminatedUnion("format", [...liveBinaryTargetSummaryVariants]),
);

/**
 * The contract an MCP client opens a target with. CLI commands that open their
 * target take its fields as options; startup reads it here rather than through
 * the complete catalog.
 */
export const OPEN_BINARY_TOOL_CONTRACT = {
  name: "open_binary",
  // Lifecycle transitions can retire an IDA client, including a pending
  // cleanup from an earlier provider, over its configured MCP transport.
  // Retiring Ghidra can discard ephemeral edits or save a configured checkpoint.
  ...toolContractMetadata(
    "open_binary",
    toolEffects({
      mutatesSession: true,
      writesFilesystem: true,
      launchesProcess: true,
      accessesNetwork: true,
      mayDiscardData: true,
    }),
  ),
  description:
    "Open a validated local artifact or analysis database and bind its analysis provider. Switching target/provider can discard ephemeral Ghidra edits even if the later open fails; retained investigation Evidence does not restore them. Reopening the same target/profile retains the engine and edits. provider_id selects a provider or deterministic auto routing, with no failure fallback. Omitted format uses headers; format dos-com admits 1..65280 headerless bytes, while raw-binary requires architecture and entry_point and maps file offset 0 there. Optional snapshots must match target, provider and analysis profile; close/reopen before importing into a mutated engine. For Ghidra cross-process edits, set a private absolute REA_GHIDRA_CHECKPOINT_DIR at startup (stock ELF/PE/Mach-O on Linux/macOS); normal opens/closes restore/save metadata. Failed opens report selection_at_failure and target/provider at completion; use binary_session for current state. close_binary releases engine resources; reset_investigation clears retained records.",
  kind: "session",
  inputSchema: openBinaryInputSchema,
  outputSchema: openBinaryOutputSchema,
  examples: examplesFor("open_binary", openBinaryInputSchema),
} as const satisfies ToolContract<"open_binary", typeof openBinaryInputSchema>;
