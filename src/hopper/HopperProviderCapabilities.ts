import {
  HOPPER_PROVIDER_IDENTITY,
  HOPPER_OPERATIONS,
} from "./HopperProviderMetadata.js";
import {
  DEFAULT_REGEX_MATCHING_DEADLINE,
  type RegexMatchingDeadline,
} from "../config/regexMatchingDeadline.js";
import {
  DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  type RegexWorkerHeapRequest,
} from "../config/regexWorkerHeapRequest.js";
import { launchRegexMatchingLimitation } from "../process/RegexMatcher.js";
import type { CapabilityDescriptor } from "../application/AnalysisProvider.js";

const MUTATING_OPERATIONS = new Set<string>([
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
]);

/** Source-owned capabilities without acquiring or probing a Hopper session. */
export const hopperCapabilities = (
  deadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
  heapRequest: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): readonly CapabilityDescriptor[] =>
  Object.freeze(
    [...HOPPER_OPERATIONS, "search_bytes" as const].map((operation) =>
      Object.freeze({
        provider: HOPPER_PROVIDER_IDENTITY,
        operation,
        // Hopper's GUI can change the document without a revision token.
        cachePolicy: "live" as const,
        ...(operation === "search_bytes"
          ? {
              available: false as const,
              reason: "Masked byte search has not been verified for Hopper.",
            }
          : { available: true as const, reason: null }),
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
          ...(operation === "address_to_file_offset"
            ? [
                "Original-file coordinates require source bytes matching the selected executable digest. A changed, unavailable, or database-only source retains native mapping facts in partial error evidence.",
              ]
            : []),
          ...(operation === "search_strings" ||
          operation === "search_procedures"
            ? [
                `${launchRegexMatchingLimitation(deadline, heapRequest)} Literal mode retains native casefold semantics.`,
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
