import type {
  AnalysisOperation,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../ports/AnalysisProvider.js";
import type { ProviderRejectionCode } from "../domain/providerSelection.js";
import { launchRegexMatchingLimitation } from "../process/RegexMatcher.js";
import { DEFAULT_REGEX_MATCHING_DEADLINE, type RegexMatchingDeadline } from "../config/regexMatchingDeadline.js";
import { DEFAULT_REGEX_WORKER_HEAP_REQUEST, type RegexWorkerHeapRequest } from "../config/regexWorkerHeapRequest.js";

/** Public identity committed by every Leandec-backed observation. */
export const LEANDEC_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "leandec",
  name: "Leandec",
  version: null,
});

/** Read-only analyst outcomes Leandec's persistent Ghidra cache answers. */
export const LEANDEC_OPERATIONS = Object.freeze([
  "list_documents",
  "list_procedures",
  "search_procedures",
  "list_strings",
  "search_strings",
  "procedure_address",
  "address_name",
  "procedure_pseudo_code",
  "procedure_assembly",
  "procedure_callers",
  "procedure_callees",
  "xrefs",
  "read_bytes",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);

export type LeandecOperation = (typeof LEANDEC_OPERATIONS)[number];

export const isLeandecOperation = (
  operation: AnalysisOperation,
): operation is LeandecOperation =>
  (LEANDEC_OPERATIONS as readonly string[]).includes(operation);

const PROVENANCE =
  "Leandec answers from its persistent SQLite cache, populated once by Ghidra; pseudocode and assembly are provider reconstructions, never original source.";

const INVENTORY_LIMITATION =
  "Leandec lists the function entries its import found. Inlined bodies are not separate entries and extents are Ghidra estimates.";

const STRING_LIMITATION =
  "Strings are those captured at import time. Packed, undefined or non-printable literals can be missing; an empty result is not proof of absence.";

const REFERENCE_LIMITATION =
  "References come from Leandec's cached reference index for analyzed functions. Unresolved indirect calls and targets outside that inventory can be absent; an empty result is not proof of absence.";

const TEXT_LIMITATION =
  "Decompiled text keeps Ghidra's inferred signatures, varargs argument order and local names; verify instruction precision with procedure_assembly.";

const BYTES_LIMITATION =
  "read_bytes returns the original slice bytes and marks stored overlay patches instead of applying them.";

/** The limitations that apply to one operation's answer, and only those. */
export const leandecLimitations = (
  operation: LeandecOperation,
  deadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
  heapRequest: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): readonly string[] => {
  switch (operation) {
    case "list_documents":
      return [];
    case "list_procedures":
    case "procedure_address":
    case "address_name":
      return [PROVENANCE, INVENTORY_LIMITATION];
    case "search_procedures":
      return [PROVENANCE, INVENTORY_LIMITATION, launchRegexMatchingLimitation(deadline, heapRequest)];
    case "list_strings":
      return [PROVENANCE, STRING_LIMITATION];
    case "search_strings":
      return [PROVENANCE, STRING_LIMITATION, launchRegexMatchingLimitation(deadline, heapRequest)];
    case "procedure_callers":
    case "procedure_callees":
    case "xrefs":
      return [PROVENANCE, REFERENCE_LIMITATION];
    case "procedure_pseudo_code":
      return [PROVENANCE, TEXT_LIMITATION];
    case "procedure_assembly":
      return [PROVENANCE, TEXT_LIMITATION];
    case "read_bytes":
      return [PROVENANCE, BYTES_LIMITATION];
  }
};

/** Advertise Leandec's static, read-only operations truthfully. */
export const leandecCapabilities = (
  availability:
    | { readonly available: true }
    | {
        readonly available: false;
        readonly reason: string;
        readonly code: ProviderRejectionCode;
      },
  deadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
  heapRequest: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): readonly CapabilityDescriptor[] =>
  LEANDEC_OPERATIONS.map((operation) => ({
    provider: LEANDEC_PROVIDER_IDENTITY,
    operation,
    ...(availability.available
      ? ({ available: true, reason: null } as const)
      : ({
          available: false,
          reason: availability.reason,
          availabilityCode: availability.code,
        } as const)),
    // Leandec's durable cache is the reuse boundary; REA snapshots add no value
    // and would freeze text that a later on-demand decompilation can improve.
    cachePolicy: "live",
    effects: {
      mutatesArtifact: false,
      launchesProcess: true,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: true,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: Object.freeze(leandecLimitations(operation, deadline, heapRequest)),
  }));
