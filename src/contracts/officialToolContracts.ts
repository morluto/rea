import { z } from "zod";
import { nativeFunctionAnnotationsInputSchema } from "../domain/native/nativeFunctionAnnotations.js";

import {
  officialOutputSchemas,
  requireOutputSchema,
} from "./toolOutputSchemas.js";
import {
  address,
  document,
  examplesFor,
  optionalAddress,
  procedure,
} from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { nativeDataTypeInputSchema } from "../domain/native/nativeDataType.js";
import { nativeInstructionInputSchema } from "../domain/native/nativeInstruction.js";
import { functionInstructionInputSchema } from "./functionInstructionContract.js";
import { HOPPER_MEMORY_TOOL_DEFINITIONS } from "./hopperMemoryContracts.js";
import { analysisSearchInput } from "./analysisSearchContract.js";

const official = <Name extends string, Schema extends z.ZodObject>(
  name: Name,
  description: string,
  inputSchema: Schema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    kind: "official-proxy",
    inputSchema,
    outputSchema: requireOutputSchema(officialOutputSchemas, name),
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, Schema>;

/** Bridge operations exposed without additional application composition. */
export const OFFICIAL_TOOL_CONTRACTS = [
  official(
    "annotate_native_function",
    "Atomically update one function name and/or entry comments, read them back, and return a refreshed complete function dossier. Ghidra changes its ephemeral session analysis database only; original executable bytes remain unchanged. Empty comment text clears that comment. Edits remain available to subsequent MCP calls until close; CLI returns the updated dossier before discarding its session. Invalid edits roll back the entire operation. Windows P0 and providers without this capability are unsupported.",
    nativeFunctionAnnotationsInputSchema,
  ),
  official(
    "inspect_native_load_image",
    "Verify the provider's loaded DOS MZ or explicitly selected COM image against its immutable target snapshot: complete original/modified source-byte digests, header/module file mappings and memory digests, relocations and external entry. Returns measured observations and independent checks with mismatch coordinates. COM verification includes its imposed entry register context and does not claim PSP/runtime coverage. Overlay and uninitialized coverage remain explicit; other formats return unsupported. Does not execute or modify the target.",
    z.strictObject({}),
  ),
  official(
    "inspect_native_data_type",
    "Inspect one recovered type by exact database category path or defined typed data address. Returns observed size, alignment, packing, fields, bitfields, enum values, and child type identities; source-level authority and flexible-tail semantics remain unknown unless substantiated.",
    nativeDataTypeInputSchema,
  ),
  official(
    "inspect_native_instruction",
    "Inspect one exact instruction address: decoded bytes, mnemonic, ordered operand tokens, flow and typed references. Memory addressing decomposition is unavailable when the provider supplies only tokens. Data, interior instruction addresses and undecodable bytes are distinct outcomes.",
    nativeInstructionInputSchema,
  ),
  official(
    "resolve_native_call_targets",
    "Resolve one explicit static call site using typed provider call references. Preserves ambiguous targets as candidates and unresolved computed calls as unknown; does not execute code or traverse a call graph.",
    nativeInstructionInputSchema,
  ),
  official(
    "address_name",
    "Resolve the primary analyzed name at a code or data address. Headless providers require an explicit address; GUI providers may default to their current cursor. Null means the provider has no primary name at that address.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "comment",
    "Read the regular analysis comment at an address, defaulting to the current cursor. This is read-only and returns null when no comment exists; use set_comment to persist a finding.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "current_address",
    "Return Hopper's current cursor address for the selected document. Use only for interactive navigation state; prefer explicit addresses in reproducible investigations.",
    z.object({ document }),
  ),
  official(
    "current_procedure",
    "Return the analyzed procedure containing Hopper's current cursor. This uses GUI cursor state and is not a procedure-name lookup.",
    z.object({ document }),
  ),
  official(
    "current_document",
    "Return the document currently selected by REA's Hopper bridge.",
    z.object({}),
  ),
  official(
    "goto_address",
    "Move Hopper's GUI cursor to a hexadecimal address and return the resolved address. This changes navigation state but not analysis data; use explicit-address tools for headless workflows.",
    z.object({ address, document }),
  ),
  official(
    "inline_comment",
    "Read the inline instruction comment at an address, defaulting to the current cursor. Returns null when absent; use set_inline_comment to write one.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "list_bookmarks",
    "List every bookmark in the selected Hopper document as address and name pairs. Use bookmarks as analyst-authored navigation aids; this does not discover code references.",
    z.object({ document }),
  ),
  official(
    "list_documents",
    "List provider program or document identities. Hopper may expose several documents; a Ghidra headless session contains exactly its one imported Program.",
    z.object({}),
  ),
  official(
    "list_names",
    "List every analyzed memory and external symbol as address/value pairs. Provider metadata distinguishes Ghidra primary, dynamic, external, type, and source facts when available.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "list_procedures",
    "List every analyzed procedure as address/value pairs after provider analysis. Ghidra metadata distinguishes thunks and external functions; use returned addresses in later function operations.",
    z.object({ document }),
  ),
  official(
    "list_segments",
    "List segments or memory blocks using exclusive end addresses. Ghidra reports block permissions, address space, image base, initialization, and overlay facts; Hopper marks unavailable permissions explicitly.",
    z.object({ document }),
  ),
  official(
    "list_strings",
    "List every provider-defined string, or filter to one address, as address/value pairs. Ghidra also reports encoding, terminator status, and byte length.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "next_address",
    "Return the next analyzed object address after an explicit address or current cursor. This is a navigation primitive, not instruction-flow or CFG analysis.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "prev_address",
    "Return the previous analyzed instruction start before an explicit address or current cursor. This is a navigation primitive and may fail at document boundaries.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "procedure_address",
    "Resolve an unambiguous procedure symbol name or provider-normalized address to its canonical entry address. External address spaces remain explicit.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_assembly",
    "Return assembly for one analyzed procedure identified by symbol or hexadecimal address. Use when pseudocode loses calling-convention or instruction-level detail; output is currently returned as one unpaginated string.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callees",
    "Return the provider's resolved direct callees for one procedure identified by symbol or address. Unresolved indirect calls may be absent; use analyze_function and typed references to preserve available edge uncertainty.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callers",
    "Return the provider's resolved direct callers for one procedure identified by symbol or address. Results reflect completed static analysis and may omit unresolved indirect references.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_info",
    "Return provider metadata for one procedure identified by symbol or address: entrypoint, signature, locals, size, block count, and complete inclusive body ranges when observed. Body byte count and enclosing span remain distinct; unavailable extent is explicit.",
    z.object({ procedure, document }),
  ),
  official(
    "read_function_instructions",
    "Return every raw instruction for one analyzed procedure. Instruction text is provider-specific.",
    functionInstructionInputSchema,
  ),
  ...HOPPER_MEMORY_TOOL_DEFINITIONS.map(({ name, description, inputSchema }) =>
    official(name, description, inputSchema),
  ),
  official(
    "procedure_references",
    "Return every raw incoming or outgoing reference edge for one procedure. Endpoint procedures are resolved only from provider containment; Ghidra preserves observed reference kinds while providers without kind authority mark them unavailable.",
    z.object({
      procedure,
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
      document,
    }),
  ),
  official(
    "procedure_pseudo_code",
    "Decompile one analyzed procedure by symbol name or provider-normalized address. Returns provider-specific pseudocode, never original source or cross-provider text equivalence, and may return null; request procedure_assembly when instruction precision matters.",
    z.object({ procedure, document }),
  ),
  official(
    "resolve_containing_procedure",
    "Resolve an arbitrary address, including an interior instruction or exact external entry, to its provider-analyzed containing procedure. A negative result distinguishes outside segments from not in a procedure and is never guessed from nearby symbols.",
    z.object({ address, document }),
  ),
  official(
    "search_procedures",
    "Search every analyzed procedure name using literal matching by default or regex when requested. Results are deterministic and complete.",
    z.object(analysisSearchInput),
  ),
  official(
    "search_strings",
    "Search every analyzed string using literal matching by default or regex when requested. Results are deterministic and complete.",
    z.object(analysisSearchInput),
  ),
  official(
    "set_address_name",
    "Assign an analyst name to one hexadecimal address and report Hopper's boolean result. This mutates analysis metadata.",
    z.object({ address, name: z.string(), document }),
  ),
  official(
    "set_addresses_names",
    "Assign analyst names to multiple addresses in one call and return per-address success booleans. This mutates analysis metadata; verify failures individually.",
    z.object({ names: z.record(z.string(), z.string()), document }),
  ),
  official(
    "set_bookmark",
    "Create or replace a bookmark at a hexadecimal address and report success. This mutates navigation metadata; bookmarks are analyst-authored navigation aids, not binary evidence.",
    z.object({ address, name: z.string().optional(), document }),
  ),
  official(
    "set_comment",
    "Write a regular analysis comment at a hexadecimal address and return whether readback matched. This mutates the Hopper document; use comments to record evidence IDs or reasoning.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "set_current_document",
    "Select an already-open Hopper document by exact document name. This changes subsequent default-document routing; list_documents can supply names when needed, while explicit document inputs keep calls reproducible.",
    z.object({ document: z.string() }),
  ),
  official(
    "set_inline_comment",
    "Write an inline instruction comment at a hexadecimal address and return whether readback matched. This mutates analysis metadata.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "unset_bookmark",
    "Remove the bookmark at a hexadecimal address and return whether it is absent. This mutates navigation metadata and does not alter binary bytes.",
    z.object({ address, document }),
  ),
  official(
    "xrefs",
    "Return analyzed references to a code or data address. Hopper may default to its current cursor; headless providers such as Ghidra require an explicit address. Use to connect strings, globals, selectors, and functions; bare addresses are untyped and indirect references may be incomplete.",
    z.object({ document, address: optionalAddress }),
  ),
] as const satisfies readonly ToolContract[];

/** Closed provider operation names exposed by direct analysis adapters. */
export type OfficialToolName = (typeof OFFICIAL_TOOL_CONTRACTS)[number]["name"];
