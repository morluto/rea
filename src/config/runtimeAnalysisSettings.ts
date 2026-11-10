import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { ok, type Result } from "../domain/result.js";
import type { AppConfig } from "./types.js";
import {
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES,
} from "../domain/analysisResourceLimits.js";
import {
  parseAsarListingAdmission,
  DEFAULT_ASAR_LISTING_ADMISSION,
} from "./asarListingAdmission.js";
import {
  DEFAULT_ASAR_HEADER_ADMISSION,
  parseAsarHeaderAdmission,
  type AsarHeaderAdmission,
} from "./asarHeaderAdmission.js";
import {
  resolveCaptureDecoderHeap,
  type CaptureDecoderHeap,
} from "./captureDecoderHeap.js";
import {
  parseNativeMatchingAllowance,
  type NativeMatchingAllowance,
} from "./nativeMatchingAllowance.js";

/** Typed views read the enclosing operation snapshot, never the ambient environment. */
export const runtimeAnalysisConfig = (
  config: AppConfig,
  read?: AnalysisSettingsReader,
): AppConfig => {
  if (read === undefined) return config;
  const deadline = config.regexMatchingDeadline;
  const heap = config.regexWorkerHeapRequest;
  const scan = config.hopperCallerScanBudget;
  const bridge = config.bridgeMaxRequestBytes;
  return {
    ...config,
    get ghidraStartupTimeoutMs() {
      return (
        read().overrides["ghidra.startup_timeout_ms"] ??
        config.ghidraStartupTimeoutMs
      );
    },
    get hopperStartupTimeoutMs() {
      return (
        read().overrides["hopper.startup_timeout_ms"] ??
        config.hopperStartupTimeoutMs
      );
    },
    get hopperStartupTimeoutSource() {
      return read().overrides["hopper.startup_timeout_ms"] === undefined
        ? config.hopperStartupTimeoutSource
        : "runtime";
    },
    get ghidraDecompileTimeoutSeconds() {
      const value = read().overrides["ghidra.decompile_timeout_seconds"];
      return value === undefined
        ? config.ghidraDecompileTimeoutSeconds
        : value === null
          ? undefined
          : value;
    },
    get ghidraDecompileMaxPayloadMiB() {
      const value = read().overrides["ghidra.decompile_max_payload_mib"];
      return value === undefined
        ? config.ghidraDecompileMaxPayloadMiB
        : value === null
          ? undefined
          : value;
    },
    get ghidraValueFlowMaxOperations() {
      return (
        read().overrides["ghidra.value_flow_max_operations"] ??
        config.ghidraValueFlowMaxOperations ??
        DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS
      );
    },
    get ghidraValueFlowMaxInputsPerOperation() {
      return (
        read().overrides["ghidra.value_flow_max_inputs_per_operation"] ??
        config.ghidraValueFlowMaxInputsPerOperation ??
        DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION
      );
    },
    get ghidraValueFlowMaxEdges() {
      return (
        read().overrides["ghidra.value_flow_max_edges"] ??
        config.ghidraValueFlowMaxEdges ??
        DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES
      );
    },
    regexMatchingDeadline: {
      get deadlineMs() {
        return (
          read().overrides["regex.matching_deadline_ms"] ?? deadline.deadlineMs
        );
      },
      get source() {
        return read().overrides["regex.matching_deadline_ms"] === undefined
          ? deadline.source
          : "runtime";
      },
    },
    regexWorkerHeapRequest: {
      get heapMiB() {
        return (
          read().overrides["regex.worker_heap_request_mib"] ?? heap.heapMiB
        );
      },
      get source() {
        return read().overrides["regex.worker_heap_request_mib"] === undefined
          ? heap.source
          : "runtime";
      },
    },
    hopperCallerScanBudget: {
      ...scan,
      get milliseconds() {
        return (
          read().overrides["hopper.caller_scan_budget_ms"] ?? scan.milliseconds
        );
      },
      get source() {
        return read().overrides["hopper.caller_scan_budget_ms"] === undefined
          ? scan.source
          : "runtime";
      },
    },
    bridgeMaxRequestBytes: {
      get maximumBytes() {
        return (
          read().overrides["bridge.max_request_bytes"] ?? bridge.maximumBytes
        );
      },
      get source() {
        return read().overrides["bridge.max_request_bytes"] === undefined
          ? bridge.source
          : "runtime";
      },
    },
  };
};
export const runtimeAsarHeaderAdmission = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): AsarHeaderAdmission => {
  const parsed = parseAsarHeaderAdmission(
    environment.REA_ASAR_MAX_HEADER_BYTES,
  );
  const headerOverride =
    read?.().overrides["asar.max_header_bytes"] ??
    currentAnalysisSettingOverride("asar.max_header_bytes");
  if (!parsed.ok && headerOverride === undefined) throw parsed.error;
  const listing = parseAsarListingAdmission(
    environment.REA_ASAR_MAX_LISTING_BYTES,
  );
  const listingOverride =
    read?.().overrides["asar.max_listing_bytes"] ??
    currentAnalysisSettingOverride("asar.max_listing_bytes");
  if (!listing.ok && listingOverride === undefined) throw listing.error;
  const baseline = parsed.ok ? parsed.value : DEFAULT_ASAR_HEADER_ADMISSION;
  const listingBaseline = listing.ok
    ? listing.value
    : DEFAULT_ASAR_LISTING_ADMISSION;
  return read === undefined
    ? {
        maximumBytes: headerOverride ?? baseline.maximumBytes,
        source: headerOverride === undefined ? baseline.source : "runtime",
        listing: {
          maximumBytes: listingOverride ?? listingBaseline.maximumBytes,
          source:
            listingOverride === undefined ? listingBaseline.source : "runtime",
        },
      }
    : {
        listing: {
          get maximumBytes() {
            return (
              read().overrides["asar.max_listing_bytes"] ??
              listingBaseline.maximumBytes
            );
          },
          get source() {
            return read().overrides["asar.max_listing_bytes"] === undefined
              ? listingBaseline.source
              : "runtime";
          },
        },
        get maximumBytes() {
          return (
            read().overrides["asar.max_header_bytes"] ?? baseline.maximumBytes
          );
        },
        get source() {
          return read().overrides["asar.max_header_bytes"] === undefined
            ? baseline.source
            : "runtime";
        },
      };
};
export const runtimeCaptureDecoderHeap = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): CaptureDecoderHeap => {
  const baseline = resolveCaptureDecoderHeap(environment);
  return read === undefined
    ? baseline
    : {
        get oldGenerationMiB() {
          return (
            read().overrides["capture.decoder_old_generation_mib"] ??
            baseline.oldGenerationMiB
          );
        },
        get source() {
          return read().overrides["capture.decoder_old_generation_mib"] ===
            undefined
            ? baseline.source
            : "runtime";
        },
      };
};
/**
 * Resolve the accepted operation's allowance on each call. An invalid launch
 * value is refused only by the operation it bounds, so MCP stays available
 * and a runtime override can repair it.
 */
export const runtimeNativeMatchingAllowance =
  (
    environment: Readonly<Record<string, string | undefined>>,
    read?: AnalysisSettingsReader,
  ): (() => Result<NativeMatchingAllowance, ConfigurationError>) =>
  () => {
    const override = read?.().overrides["native.matching_representation_bytes"];
    return override === undefined
      ? parseNativeMatchingAllowance(environment)
      : ok({ maximumBytes: override, source: "runtime" });
  };
