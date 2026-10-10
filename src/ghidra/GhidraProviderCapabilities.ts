import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import {
  hasWindowsNativeAuthority,
  windowsNativeAuthorityUnavailableReason,
} from "../process/WindowsAuthority.js";
import { GHIDRA_FUNCTION_OPERATIONS } from "./GhidraFunctionValues.js";
import { GHIDRA_INVENTORY_OPERATIONS } from "./GhidraInventoryValues.js";

/** Public identity committed by every Ghidra-backed observation. */
export const GHIDRA_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "ghidra",
  name: "Ghidra",
  version: null,
});

/** Analyst operations implemented by the Ghidra inventory and function adapters. */
export const GHIDRA_OPERATIONS = Object.freeze([
  ...GHIDRA_INVENTORY_OPERATIONS,
  ...GHIDRA_FUNCTION_OPERATIONS,
]);

/** Health limitations shared by every Ghidra-backed capability. */
export const healthLimitations = Object.freeze([
  "The session serves operations only after Ghidra reports default auto-analysis complete; incomplete analysis does not expose partial results.",
  "The imported Program and temporary project are ephemeral and deleted on close. Annotation operations edit session database metadata; original executable bytes are never written.",
  "Cancelling an active Ghidra request terminates its ephemeral database and discards session annotations. The selected target remains open; the next provider query imports the original artifact again.",
]);

/** Additional limitations applied to the experimental Windows x64 P0 boundary. */
export const windowsP0Limitations = Object.freeze([
  "Windows Ghidra P0 accepts approved native x86 and x86-64 PE applications and DLLs; managed, hostile, sensitive, and mutable-path targets are unsupported.",
  "The Windows bridge uses authenticated IPv4 loopback because Node path-based IPC does not expose Java AF_UNIX sockets; the endpoint file contains no bearer token.",
  "Windows sessions require the matching packaged Windows x64 native addon, local NTFS targets and runtimes, and Windows 10 or later. Native handles enforce path admission, private DACLs, and Job Object ownership automatically.",
]);

/** Limitation text for one admitted operation, including the common base. */
export const limitationsFor = (operation: string): readonly string[] => {
  const common = [
    ...healthLimitations,
    "Default-space addresses use lowercase 0x-prefixed hexadecimal; other address spaces use <percent-encoded-space>:0x<hex>.",
  ];
  switch (operation) {
    case "annotate_native_function":
      return [
        ...common,
        "Names use Ghidra USER_DEFINED source. Name writes accept a leaf name or a fully qualified name within the existing namespace; readback uses the fully qualified name and can be reused without adding namespace prefixes. Edits retain the current namespace; other namespace-like text remains literal leaf-name text. Regular comments map to PRE and inline comments to EOL at the exact function entry. Changes commit together after readback and refreshed analysis; failure rolls them all back.",
        "Annotation text rejects NUL and unpaired Unicode surrogates before mutation, with the field and UTF-16 index in the error. Supported Unicode and line endings are preserved.",
        "Metadata edits invalidate immutable analysis snapshots and are discarded on close. CLI returns the updated dossier before session cleanup; this is not a saved Ghidra project.",
      ];
    case "inspect_native_load_image":
      return [
        ...common,
        "Independent verification supports DOS MZ and explicitly selected COM, including measured COM entry context. Measured source mappings use inclusive end addresses and complete region digests; no target execution or project mutation occurs.",
      ];
    case "read_bytes":
      return [
        ...common,
        "Bytes reflect Ghidra's initialized memory, including loader fixups. Reads stop at an unmapped or uninitialized byte and report completeness explicitly.",
      ];
    case "address_to_file_offset":
      return [
        ...common,
        "Offsets come from Ghidra source-byte mappings, not virtual-address arithmetic. Uninitialized memory, missing mappings and ambiguous mappings fail explicitly.",
      ];
    case "list_documents":
      return [
        ...common,
        "A headless Ghidra session contains exactly one imported Program, unlike Hopper's multi-document GUI session.",
      ];
    case "list_names":
      return [
        ...common,
        "The symbol inventory includes memory and external symbols, including dynamic symbols, but excludes variable and no-address namespace records.",
      ];
    case "list_procedures":
    case "procedure_address":
      return [
        ...common,
        "External functions and local thunks are distinct; procedure metadata identifies both and preserves a thunk target when Ghidra resolves one.",
      ];
    case "list_strings":
      return [
        ...common,
        "Only Ghidra-defined string Data is observed; charset is reported, while a non-missing terminator cannot distinguish a present terminator from a fixed or Pascal layout.",
      ];
    case "resolve_containing_procedure":
      return [
        ...common,
        "An exact external entry resolves to its observed function identity even when its body is empty. This does not establish mapped executable bytes or containment of nearby external addresses.",
      ];
    case "list_segments":
      return [
        ...common,
        "Memory-block end addresses are exclusive; permissions come from Ghidra MemoryBlock flags rather than inference from section names.",
      ];
    case "search_procedures":
    case "search_strings":
      return [
        ...common,
        "Regex mode uses Java Pattern semantics. Matcher or compiler stack exhaustion returns a resource constraint without closing the session; literal mode avoids regex recursion and returns complete matching values.",
      ];
    case "procedure_pseudo_code":
      return [
        ...common,
        "Pseudocode is Ghidra decompiler output, not original source and not text-equivalent to Hopper output.",
        "External functions and functions without an analyzable body return null; other decompiler failures remain explicit.",
      ];
    case "read_function_instructions":
      return [
        ...common,
        "This fast path reads only the requested function and does not invoke the decompiler or whole-program string/name inventories.",
        "Instruction text is Ghidra-specific and does not claim textual equivalence with Hopper output.",
      ];
    case "procedure_assembly":
      return [
        ...common,
        "Assembly is Ghidra Listing text and does not claim textual equivalence with Hopper output.",
      ];
    case "procedure_callers":
    case "procedure_callees":
      return [
        ...common,
        "Only resolved Ghidra call references are returned; unresolved computed or indirect calls remain unknown, while function classifications distinguish thunks and externals.",
      ];
    case "xrefs":
      return [
        ...common,
        "The direct address list projects exact Ghidra references to one address but does not expose their kinds; procedure_references and analyze_function preserve available kind metadata.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
      ];
    case "procedure_references":
      return [
        ...common,
        "References cover the complete Ghidra function-body AddressSet and exact entry, including instruction-interior destinations and embedded-data sources; an enclosing address span does not establish function ownership.",
        "Reference kinds are direct Ghidra ReferenceManager observations; unresolved computed flows without a target are absent and remain unknown.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
      ];
    case "analyze_function":
      return [
        ...common,
        "References cover the complete Ghidra function-body AddressSet and exact entry. Dossier incoming edges omit sources owned by that function; procedure_references also retains those internal edges.",
        "The dossier combines Ghidra FunctionManager, Listing, ReferenceManager, BasicBlockModel, and decompiler observations; provider-specific pseudocode and assembly are not cross-provider text invariants.",
        "Resolved reference metadata identifies computed, indirect, external, call, jump, and data edges; unresolved targetless flows remain unknown, and function classifications distinguish thunks and externals.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
        "The Java bridge serializes one function request per Program and lets each decompilation run until it completes or the caller cancels.",
      ];
    default:
      return common;
  }
};

/** Provider-neutral capabilities advertised by every non-Windows Ghidra session. */
export const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  GHIDRA_OPERATIONS.map((operation) => {
    return Object.freeze({
      provider: GHIDRA_PROVIDER_IDENTITY,
      operation,
      available: true,
      reason: null,
      // Project writes are private import machinery. Analysis reads are bound
      // to the artifact/profile; session annotations disable snapshot replay.
      ...(operation === "annotate_native_function" ||
      operation === "list_documents"
        ? {}
        : { cachePolicy: "snapshot" as const }),
      effects: Object.freeze({
        mutatesArtifact: operation === "annotate_native_function",
        launchesProcess: true,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: true,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limitations: Object.freeze(limitationsFor(operation)),
    });
  }),
);

/** Capabilities advertised for the experimental Windows x64 P0 boundary. */
export const windowsP0Capabilities = (): readonly CapabilityDescriptor[] => {
  const available = hasWindowsNativeAuthority("win32");
  return Object.freeze(
    CAPABILITIES.map((capability): CapabilityDescriptor => {
      const limitations = Object.freeze([
        ...capability.limitations,
        ...windowsP0Limitations,
      ]);
      if (capability.effects.mutatesArtifact)
        return Object.freeze({
          ...capability,
          available: false,
          reason: "Windows Ghidra P0 does not admit database mutation.",
          availabilityCode: "unsupported_host",
          limitations,
        });
      return available
        ? Object.freeze({ ...capability, limitations })
        : Object.freeze({
            ...capability,
            available: false,
            reason: windowsNativeAuthorityUnavailableReason("win32"),
            availabilityCode: "unsupported_host",
            limitations,
          });
    }),
  );
};
