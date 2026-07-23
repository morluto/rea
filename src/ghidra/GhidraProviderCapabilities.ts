import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import {
  GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
  GHIDRA_MAX_LINE_BYTES,
  GHIDRA_REQUEST_TIMEOUT_MS,
} from "./GhidraDefaults.js";
import { GHIDRA_FUNCTION_OPERATIONS } from "./GhidraFunctionValues.js";
import { GHIDRA_INVENTORY_OPERATIONS } from "./GhidraInventoryValues.js";

/** Public identity committed by every Ghidra-backed observation. */
export const GHIDRA_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "ghidra",
  name: "Ghidra",
  version: null,
});

const providerContractByName = new Map(
  [...OFFICIAL_TOOL_CONTRACTS, ...ENHANCED_TOOL_CONTRACTS].map((contract) => [
    contract.name,
    contract,
  ]),
);

/** Provider-neutral read-only contracts implemented by the Ghidra adapter. */
export const GHIDRA_PROVIDER_TOOL_CONTRACTS = Object.freeze(
  [...GHIDRA_INVENTORY_OPERATIONS, ...GHIDRA_FUNCTION_OPERATIONS].map(
    (operation) => {
      const contract = providerContractByName.get(operation);
      if (contract === undefined)
        throw new TypeError(
          `Missing provider-neutral contract for ${operation}`,
        );
      return contract;
    },
  ),
);

const PAGINATED_OPERATIONS: ReadonlySet<string> = new Set([
  "list_names",
  "list_procedures",
  "list_strings",
  "search_procedures",
  "search_strings",
  "procedure_references",
  "read_function_instructions",
  "analyze_function",
]);
const SEARCH_OPERATIONS: ReadonlySet<string> = new Set([
  "search_procedures",
  "search_strings",
]);
const DECOMPILE_OPERATIONS: ReadonlySet<string> = new Set([
  "procedure_pseudo_code",
  "analyze_function",
]);

/** Health limitations shared by every Ghidra-backed capability. */
export const healthLimitations = Object.freeze([
  "The session serves operations only after default Ghidra auto-analysis completes; an analysis timeout fails the open instead of exposing partial results.",
  "The imported Program and temporary project are ephemeral, read-only to REA, and deleted on close.",
]);

/** Additional limitations applied to the experimental Windows x64 P0 boundary. */
export const windowsP0Limitations = Object.freeze([
  "Windows Ghidra P0 accepts approved native x86-64 PE applications only; DLL, managed, hostile, sensitive, and mutable-path targets are unsupported.",
  "The Windows bridge uses authenticated IPv4 loopback because Node path-based IPC does not expose Java AF_UNIX sockets; the endpoint file contains no bearer token.",
  "Windows P0 process-tree cleanup uses bounded taskkill termination and does not claim Job Object ownership, private DACL enforcement, or reparse-point-safe path authority.",
]);

/** Limitation text for one admitted operation, including the common base. */
export const limitationsFor = (operation: string): readonly string[] => {
  const common = [
    ...healthLimitations,
    "Default-space addresses use lowercase 0x-prefixed hexadecimal; other address spaces use <percent-encoded-space>:0x<hex>.",
  ];
  switch (operation) {
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
        "Returned values are bounded to 1,024 Unicode code points and mark value_truncated instead of silently crossing the wire budget.",
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
        "Literal search enforces 1,000,000 cumulative work units; regex mode also accepts only a conservative finite Java-regex subset with 10,000 static paths and 4,096 UTF-16 code units per candidate.",
      ];
    case "procedure_pseudo_code":
      return [
        ...common,
        "Pseudocode is Ghidra decompiler output, not original source and not text-equivalent to Hopper output; each decompile has a 30-second native deadline.",
        "External functions and functions without an analyzable body return null; other decompiler failures remain explicit.",
      ];
    case "read_function_instructions":
      return [
        ...common,
        "This bounded fast path reads only the requested function instruction window and does not invoke the decompiler or whole-program string/name inventories.",
        "Instruction text is Ghidra-specific and does not claim textual equivalence with Hopper output.",
      ];
    case "procedure_assembly":
      return [
        ...common,
        "Assembly is Ghidra Listing text and fails rather than silently truncating when the 100,000-instruction or 1 MiB wire bound is exceeded.",
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
        "Reference kinds are direct Ghidra ReferenceManager observations; unresolved computed flows without a target are absent and remain unknown.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
        "Instruction scans stop at max_instructions; a truncated scan reports an unknown total and no false continuation.",
      ];
    case "analyze_function":
      return [
        ...common,
        "The dossier combines Ghidra FunctionManager, Listing, ReferenceManager, BasicBlockModel, and decompiler observations; provider-specific pseudocode and assembly are not cross-provider text invariants.",
        "Resolved reference metadata identifies computed, indirect, external, call, jump, and data edges; unresolved targetless flows remain unknown, and function classifications distinguish thunks and externals.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
        "The Java bridge serializes one function request per Program through a bounded 32-request queue and applies a 30-second native decompilation deadline.",
      ];
    default:
      return common;
  }
};

/** Provider-neutral capabilities advertised by every non-Windows Ghidra session. */
export const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  GHIDRA_PROVIDER_TOOL_CONTRACTS.map((contract) =>
    Object.freeze({
      provider: GHIDRA_PROVIDER_IDENTITY,
      operation: contract.name,
      inputContractVersion: 1,
      outputContractVersion: 1,
      available: true,
      reason: null,
      pagination: PAGINATED_OPERATIONS.has(contract.name)
        ? ("offset" as const)
        : ("none" as const),
      exhaustive: !PAGINATED_OPERATIONS.has(contract.name),
      effects: Object.freeze({
        mutatesArtifact: false,
        launchesProcess: true,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: true,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limits: Object.freeze({
        maxResults: PAGINATED_OPERATIONS.has(contract.name)
          ? SEARCH_OPERATIONS.has(contract.name)
            ? 100
            : 500
          : null,
        maxPayloadBytes: GHIDRA_MAX_LINE_BYTES,
        timeoutMs: DECOMPILE_OPERATIONS.has(contract.name)
          ? GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS
          : GHIDRA_REQUEST_TIMEOUT_MS,
      }),
      limitations: Object.freeze(limitationsFor(contract.name)),
    }),
  ),
);

/** Capabilities advertised for the experimental Windows x64 P0 boundary. */
export const WINDOWS_P0_CAPABILITIES: readonly CapabilityDescriptor[] =
  Object.freeze(
    CAPABILITIES.map((capability) =>
      Object.freeze({
        ...capability,
        limitations: Object.freeze([
          ...capability.limitations,
          ...windowsP0Limitations,
        ]),
      }),
    ),
  );
