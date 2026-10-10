import type {
  AnalysisOperation,
  CapabilityDescriptor,
} from "../application/AnalysisProvider.js";

/** This version identifies REA's adapter, not IDA or the upstream Python package. */
export const IDA_PROVIDER_IDENTITY = Object.freeze({
  id: "ida",
  name: "IDA Pro MCP adapter",
  version: "1",
});

/** Read-only analyst outcomes supported by both upstream compatibility profiles. */
export const IDA_OPERATIONS = Object.freeze([
  "list_procedures",
  "search_procedures",
  "list_strings",
  "search_strings",
  "procedure_address",
  "procedure_pseudo_code",
  "procedure_assembly",
  "procedure_callers",
  "procedure_callees",
  "read_function_instructions",
  "xrefs",
  "analyze_function",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
export type IdaOperation = (typeof IDA_OPERATIONS)[number];

/** Shared limitations of observations from an externally mutable analysis database. */
export const IDA_LIMITATIONS = Object.freeze([
  "Provider version identifies the REA IDA adapter. IDA engine and upstream distribution versions are unknown unless separately observed; MCP serverInfo is reported independently.",
  "Results describe the current IDA analysis database. Input identity does not prove an unmodified database; patches, annotations, analysis completeness, and database revision remain unknown.",
  "Live results are never replayed from analysis snapshots. Target checks before and after a request do not provide an atomic lock against external GUI changes.",
  "Caller cancellation drains the in-flight MCP request before cleanup; it does not prove that IDA engine work was interrupted.",
  "Headless workers are released through the upstream database lifecycle. Abrupt termination of REA, its proxy, or the supervisor cannot prove worker cleanup; inspect upstream inventory after an interrupted process.",
  "Complete function body ranges, typed references, unresolved indirect calls, referenced data, and basic blocks are unavailable in this adapter. Empty unsupported dossier facets are unknown, not observed absence.",
]);

/** Advertise live observations and configured lifecycle effects truthfully. */
export const idaCapabilities = (
  mode: "attached" | "headless",
  stdio: boolean,
  native = false,
): readonly CapabilityDescriptor[] =>
  IDA_OPERATIONS.map((operation) => ({
    provider: IDA_PROVIDER_IDENTITY,
    operation,
    ...((mode === "headless" || native) && operation === "procedure_callers"
      ? ({
          available: false,
          reason: native
            ? "The native upstream profile reports code references without proving direct call edges."
            : "The modern upstream profile reports code references without proving direct call edges.",
        } as const)
      : ({ available: true, reason: null } as const)),
    cachePolicy: "live",
    effects: {
      mutatesArtifact: false,
      launchesProcess: stdio || mode === "headless",
      mayShowUi:
        native &&
        (operation === "procedure_pseudo_code" ||
          operation === "analyze_function"),
      mayAccessNetwork: true,
      mayWriteFilesystem: stdio || mode === "headless",
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: IDA_LIMITATIONS,
  }));
