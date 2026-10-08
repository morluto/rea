import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { OfficialToolName } from "../contracts/officialToolContracts.js";

/** Public identity committed by every Hopper-backed observation. */
export const HOPPER_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "hopper",
  name: "Hopper Disassembler",
  version: null,
});

/** Analyst operations implemented by REA's private Hopper bridge. */
export const HOPPER_OPERATIONS = Object.freeze([
  "address_name",
  "comment",
  "current_address",
  "current_procedure",
  "current_document",
  "goto_address",
  "inline_comment",
  "list_bookmarks",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "next_address",
  "prev_address",
  "procedure_address",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "read_function_instructions",
  "read_bytes",
  "address_to_file_offset",
  "procedure_references",
  "procedure_pseudo_code",
  "resolve_containing_procedure",
  "search_procedures",
  "search_strings",
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
  "xrefs",
  "analyze_function",
] as const satisfies readonly (OfficialToolName | "analyze_function")[]);

const MUTATING_OPERATIONS = new Set<string>([
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
]);

/** Source-owned capabilities without acquiring or probing a Hopper session. */
export const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  HOPPER_OPERATIONS.map((operation) =>
    Object.freeze({
      provider: HOPPER_PROVIDER_IDENTITY,
      operation,
      available: true,
      reason: null,
      effects: Object.freeze({
        mutatesArtifact: MUTATING_OPERATIONS.has(operation),
        launchesProcess: true,
        mayShowUi: true,
        mayAccessNetwork: false,
        mayWriteFilesystem: MUTATING_OPERATIONS.has(operation),
        changesPermissions: false,
        requiresRoot: false,
      }),
      limitations: Object.freeze([
        "Results depend on Hopper's completed static analysis.",
        ...(operation === "search_strings" || operation === "search_procedures"
          ? [
              "Regex mode uses ECMAScript Unicode semantics in a supervised worker with a five-second matching deadline. Cancellation or deadline failure stops matching without blocking Hopper; literal mode retains native casefold semantics.",
            ]
          : []),
        ...(operation === "list_strings" ||
        operation === "search_strings" ||
        operation === "analyze_function"
          ? [
              "String values cover native typed objects. Hopper may split long literals into adjacent unterminated fragments; string searches match each object independently.",
              "Undecodable typed objects retain native display text with an explicit decoding unknown; these values do not establish decoded source literals.",
              "Reported string encodings are inferred from typed bytes and native display; the original source's intended encoding is unknown.",
            ]
          : []),
      ]),
    }),
  ),
);
