import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { analysisDetailSchema } from "./analysisDetail.js";
import { z } from "zod";
import { jsonRecordSchema } from "../domain/jsonRecord.js";
import { nativeFunctionAnnotationsInputSchema } from "../domain/native/nativeFunctionAnnotations.js";

import { officialOutputSchemas } from "./toolOutputSchemaGroups.js";
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
import { nativeSearchInput } from "../domain/native/nativeSearch.js";

export const decompileAnalysisSelection = z
  .enum(["independent_fresh"])
  .optional()
  .describe(
    "Request a new independent decompile, bypassing project and snapshot results. Use only when the routed provider's procedure_pseudo_code capability declares independent_decompile; otherwise the request is refused. This may use different analysis context.",
  );

const official = <
  Name extends keyof typeof officialOutputSchemas,
  Schema extends z.ZodObject,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
  retainedSummary?: ToolContract["retainedSummary"],
) => {
  const strictInputSchema = inputSchema.strict();
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "official-proxy",
    requiresActiveTarget: true,
    ...(retainedSummary === undefined ? {} : { retainedSummary }),
    inputSchema: strictInputSchema,
    outputSchema: requireOutputSchema(officialOutputSchemas, name),
    examples: examplesFor(name, strictInputSchema),
  } satisfies ToolContract<Name, typeof strictInputSchema>;
};

/** Bridge operations exposed without additional application composition. */
export const OFFICIAL_TOOL_CONTRACTS = [
  official(
    "annotate_native_function",
    "Atomically rename one function and/or change entry comments, verify readback, and return its refreshed complete dossier. Ghidra resolves interior addresses to function entries; use procedure_address to select the entry explicitly. Edits change analysis metadata, never executable bytes; empty comment text clears it. Invalid edits roll back together. Ghidra checkpoint mode saves on normal close; ephemeral mode discards edits, including in CLI cleanup. Check binary_session for the mode. Windows P0 and providers without this capability are unsupported.",
    nativeFunctionAnnotationsInputSchema,
  ),
  official(
    "inspect_native_load_image",
    "Inspect provider source digests, loaded mappings, relocations, entries and register context without executing or changing the target. Independent snapshot checks support DOS MZ, selected COM, raw binaries and GameCube DOL; other formats retain observations with unsupported verification. Relocation symbols do not prove runtime binding. detail summary retains complete Evidence for inspect_analysis_view kind native-load-image, collection source_files/mappings/relocations/entry_points/entry_context/checks/sections. Null collections are unrecorded/inapplicable; payload bytes require explicit fields. Overlay and uninitialized coverage remain explicit.",
    z.strictObject({ detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "inspect_native_data_type",
    "Inspect one recovered type by exact database category path or defined typed data address. Returns observed size, alignment, packing, fields, bitfields, enum values, and child type identities; source-level authority and flexible-tail semantics remain unknown unless substantiated.",
    nativeDataTypeInputSchema,
  ),
  official(
    "inspect_native_instruction",
    "Inspect bytes, mnemonic, operand tokens, flow and typed incoming/outgoing references at one code/data address. Ghidra preserves the query and separately reports a containing listed instruction/data object; unlisted memory is not decoded. References do not establish runtime access, and token-only operands do not establish memory decomposition. Use inspect_native_data_type at a data object's start for layout, without inferring a selected field. Retained references use inspect_analysis_view kind native-instruction-references; null coverage is unavailable or unrecorded.",
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
    "Read the regular analysis comment at an explicit address, or the current cursor where supported. Returns null when absent; use set_comment to write one.",
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
    "Move Hopper's GUI cursor to a mapped address and return the observed cursor address. Interior coordinates snap to the containing analyzed object's start. Unmapped destinations fail without moving the cursor. This changes navigation state but not analysis data; use explicit-address tools for headless workflows.",
    z.object({ address, document }),
  ),
  official(
    "inline_comment",
    "Read the inline instruction comment at an explicit address, or the current cursor where supported. Returns null when absent; use set_inline_comment to write one.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "list_bookmarks",
    "List every bookmark in the selected Hopper document as address and name pairs; unnamed bookmarks retain a null name. Use bookmarks as analyst-authored navigation aids; this does not discover code references.",
    z.object({ document }),
  ),
  official(
    "list_documents",
    "List provider program or document identities. Hopper may expose several documents; a Ghidra headless session contains exactly its one imported Program.",
    z.object({}),
  ),
  official(
    "list_names",
    "List every analyzed memory and external symbol as address/value pairs. Provider metadata distinguishes Ghidra primary, dynamic, external, type, and source facts when available. Select detail summary for counts and retained native-inventory pages; complete remains the default.",
    z.object({
      document,
      address: optionalAddress,
      detail: analysisDetailSchema,
    }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "list_procedures",
    "List every analyzed procedure as address/value pairs after provider analysis. Ghidra metadata distinguishes thunks and external functions; use returned addresses in later function operations. Select detail summary for counts and retained native-inventory pages; complete remains the default.",
    z.object({ document, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "list_segments",
    "List segments or memory blocks using exclusive end addresses. Ghidra reports block permissions, address space, image base, initialization, and overlay facts; Hopper marks unavailable permissions explicitly.",
    z.object({ document }),
  ),
  official(
    "list_strings",
    "List every provider-reported string object or candidate, or filter to one address, as address/value pairs with encoding, terminator status, and byte length when available. Hopper reads complete typed objects and retains its original display text as provider_value; long literals may span adjacent unterminated objects. Kuna scans mapped printable sequences of at least five characters, including unterminated fragments; references are not computed. Select detail summary for counts and retained native-inventory pages; complete remains the default.",
    z.object({
      document,
      address: optionalAddress,
      detail: analysisDetailSchema,
    }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "next_address",
    "Return the next analyzed object address after an explicit address or current cursor. This is a navigation primitive, not instruction-flow or CFG analysis.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "prev_address",
    "Return the previous analyzed object start before an explicit address or current cursor. This is a navigation primitive and may fail at document boundaries; data objects and instructions remain distinct from control flow.",
    z.object({ document, address: optionalAddress }),
  ),
  official(
    "procedure_address",
    "Resolve an unambiguous procedure symbol name or provider-normalized address to its canonical entry address. External address spaces remain explicit. Select detail summary for selected facts and a context digest; native-observation and native-context views retain complete source access.",
    z.object({ procedure, document, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "procedure_assembly",
    "Return assembly for one analyzed procedure identified by symbol or hexadecimal address. Use when pseudocode loses calling-convention or instruction-level detail; output is currently returned as one unpaginated string. Ghidra terminal-call assumptions that may cut the analyzed body are reported in Evidence limitations.",
    z.object({ procedure, document }),
  ),
  official(
    "procedure_callees",
    "Return the provider's resolved direct callees for one procedure identified by symbol or address. Unresolved indirect calls may be absent; use analyze_function and typed references to preserve available edge uncertainty. Ghidra terminal-call assumptions that may cut the analyzed body are reported in Evidence limitations. Select detail summary for selected facts and a context digest; native-observation and native-context views retain complete source access.",
    z.object({ procedure, document, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "procedure_callers",
    "Return the provider's resolved direct callers for one procedure identified by symbol or address. Results reflect completed static analysis and may omit unresolved indirect references. Ghidra terminal-call assumptions that may cut the analyzed body are reported in Evidence limitations. Select detail summary for selected facts and a context digest; native-observation and native-context views retain complete source access.",
    z.object({ procedure, document, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "procedure_info",
    "Return provider metadata for one procedure identified by symbol or address: entrypoint, signature, locals, size, block count, and complete inclusive body ranges when observed. Extents reflect the provider's analyzed body; Ghidra terminal-call assumptions that may cut it are reported in Evidence limitations. Hopper locals preserve observed names and signed stack displacements; source types remain unknown. Body byte count and enclosing span remain distinct; unavailable extent is explicit.",
    z.object({ procedure, document }),
  ),
  official(
    "read_function_instructions",
    "Return every raw instruction for one analyzed procedure. Instruction text and body extent are provider-specific. Ghidra terminal-call assumptions that may cut the analyzed body are reported in limitations.",
    functionInstructionInputSchema,
  ),
  ...HOPPER_MEMORY_TOOL_DEFINITIONS.map(({ name, description, inputSchema }) =>
    official(name, description, inputSchema),
  ),
  official(
    "procedure_references",
    "Return incoming or outgoing reference edges for one procedure. Ghidra preserves detailed reference flags; Hopper preserves native CallReference classifications and exact endpoints. Select detail summary to retain complete Evidence and page references or unresolved calls using inspect_analysis_view kind native-procedure-references. Page coverage describes retained observations, not complete discovery or proof the target ran.",
    z.object({
      procedure,
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
      document,
      detail: analysisDetailSchema,
    }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "procedure_pseudo_code",
    "Decompile one analyzed procedure by symbol or provider-normalized address. Returns provider-specific pseudocode or null, never original source; raw_result.pseudocode_absence distinguishes reported provider-failure from not-in-export, otherwise the cause is unknown. Use procedure_assembly for instruction precision. detail summary retains text for inspect_analysis_view native/pseudocode pages without another decompile; complete is default. analysis: independent_fresh requests a separate attempt only when binary_session advertises independent_decompile; it may use different analysis context. Ghidra accepts file-offset:0x... or unique file offsets when a 0x selector resolves to no procedure; existing analysis addresses take precedence, and space-qualified addresses avoid that fallback. Its terminal-call assumptions may truncate the analyzed body, as limitations report.",
    z.object({
      procedure,
      document,
      analysis: decompileAnalysisSelection,
      detail: analysisDetailSchema,
    }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "resolve_containing_procedure",
    "Resolve an arbitrary address, including an interior instruction or exact external entry, to its provider-analyzed containing procedure. A negative result distinguishes outside segments from not in a procedure and is never guessed from nearby symbols. Select detail summary for selected facts and a context digest; native-observation and native-context views retain complete source access.",
    z.object({ address, document, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "search_procedures",
    "Find analyzed procedures by literal name (default) or regex, including accepted secondary names. Returns deterministic provider-inventory matches under primary names with matched_aliases and available thunk/external metadata. For Ghidra case-insensitive literal searches, raw_result retains unfiltered candidates; normalized_result holds matches. detail summary retains native-inventory pages. Regex uses Java Pattern in Ghidra and ECMAScript Unicode in Kuna, IDA and Hopper; binary_session and errors report effective limits and recovery.",
    z.object({ ...nativeSearchInput, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "search_strings",
    "Find provider-reported strings by literal text (default) or regex. Complete results cover that inventory, not all artifact text; packed/undefined strings or independently matched fragments may be missing. Ghidra search_bytes finds known encoded bytes without establishing string identity/use; xrefs inspects references at a known address. Kuna scans mapped sequences of at least five characters without references or read_bytes. Hopper preserves decoded typed objects, display text and decoding unknowns. For Ghidra case-insensitive literal searches, raw_result holds candidates; normalized_result holds matches. detail summary retains native-inventory pages. Regex uses Java Pattern in Ghidra and ECMAScript Unicode elsewhere; binary_session/errors report limits.",
    z.object({ ...nativeSearchInput, detail: analysisDetailSchema }),
    { evidenceParameters: "omit-detail" },
  ),
  official(
    "set_address_name",
    "Assign an analyst name to one mapped hexadecimal address and report whether the native edit succeeded and exact readback matched. Hopper rejects symbol names exceeding 1024 UTF-16 code units before mutation, and rejects names owned by another address; use set_addresses_names to explicitly move or swap labels among selected addresses. This mutates analysis metadata.",
    z.object({ address, name: z.string(), document }),
  ),
  official(
    "set_addresses_names",
    "Assign analyst names to multiple mapped addresses in one call and return per-address edit/readback success booleans. Hopper validates mapped destinations, native string representations, its 1024 UTF-16 code-unit symbol-name limit, and unique destinations/names before applying edits; its labels may move or swap only among explicitly selected addresses, and unselected label owners remain unchanged. Ghidra rejects any address whose name another selected address also requests or holds in that namespace; others still apply, with reasons in raw_result.failures. This mutates analysis metadata; verify failures individually.",
    z.object({ names: jsonRecordSchema(z.string()), document }),
  ),
  official(
    "set_bookmark",
    "Create or update a bookmark at a mapped hexadecimal address and report readback success. Omit name to preserve an existing name or create an unnamed bookmark; an empty string clears the bookmark name. This mutates navigation metadata; bookmarks are analyst-authored navigation aids, not binary evidence.",
    z.object({ address, name: z.string().optional(), document }),
  ),
  official(
    "set_comment",
    "Write a regular analysis comment at a hexadecimal address and return whether readback matched. An empty comment clears it. This mutates the Hopper document; use comments to record evidence IDs or reasoning.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "set_inline_comment",
    "Write an inline instruction comment at a hexadecimal address and return whether readback matched. An empty comment clears it; Hopper may flatten newlines, producing false on exact readback. This mutates analysis metadata.",
    z.object({ address, comment: z.string(), document }),
  ),
  official(
    "unset_bookmark",
    "Remove the bookmark at a mapped hexadecimal address and return whether it is absent. Hopper also permits removing an existing legacy bookmark outside mapped memory. This mutates navigation metadata and does not alter binary bytes.",
    z.object({ address, document }),
  ),
  official(
    "xrefs",
    "Return analyzed references to a code or data address. Hopper may default to its current cursor; headless providers such as Ghidra require an explicit address. Kuna also accepts names in its own inventory, including data names; an unlisted name may still exist in the target. Use to connect strings, globals, selectors, and functions; bare addresses are untyped and indirect references may be incomplete. Page a retained result with inspect_analysis_view and native-observation; use native-context for source caveats. Use inspect_native_instruction at the target address for typed incoming references where supported.",
    z.object({ document, address: optionalAddress }),
  ),
] as const satisfies readonly ToolContract[];

/** Closed provider operation names exposed by direct analysis adapters. */
export type OfficialToolName = (typeof OFFICIAL_TOOL_CONTRACTS)[number]["name"];
