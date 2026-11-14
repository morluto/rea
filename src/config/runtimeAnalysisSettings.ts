import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import {
  currentAnalysisOperationSnapshot,
  currentAnalysisSettingOverride,
} from "../domain/analysisOperationSnapshot.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { ok, type Result } from "../domain/result.js";
import type { AppConfig } from "./types.js";
import {
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES,
} from "../domain/analysisResourceLimits.js";
import { parseAsarListingAdmission } from "./asarListingAdmission.js";
import {
  parseAsarHeaderAdmission,
  type AsarHeaderAdmission,
} from "./asarHeaderAdmission.js";
import {
  parseCaptureDecoderHeap,
  type CaptureDecoderHeap,
} from "./captureDecoderHeap.js";
import {
  parseNativeMatchingAllowance,
  type NativeMatchingAllowance,
} from "./nativeMatchingAllowance.js";

/**
 * Typed views read the enclosing operation snapshot, never the ambient
 * environment. A malformed launch seed is rejected here unless that snapshot
 * supplies an override. Resetting the override reveals the same seed.
 */
export const runtimeAnalysisConfig = (
  config: AppConfig,
  read?: AnalysisSettingsReader,
): AppConfig => {
  const deadline = config.regexMatchingDeadline;
  const heap = config.regexWorkerHeapRequest;
  const scan = config.hopperCallerScanBudget;
  const bridge = config.bridgeMaxRequestBytes;
  const overrides = () =>
    (read === undefined
      ? currentAnalysisOperationSnapshot()?.overrides
      : read().overrides) ?? {};
  const admit = (id: keyof NonNullable<AppConfig["invalidRuntimeSeeds"]>) => {
    const error = config.invalidRuntimeSeeds?.[id];
    if (error !== undefined) throw error;
  };
  return {
    ...config,
    get ghidraStartupTimeoutMs() {
      return (
        overrides()["ghidra.startup_timeout_ms"] ??
        (admit("ghidra.startup_timeout_ms"), config.ghidraStartupTimeoutMs)
      );
    },
    get hopperStartupTimeoutMs() {
      return (
        overrides()["hopper.startup_timeout_ms"] ??
        (admit("hopper.startup_timeout_ms"), config.hopperStartupTimeoutMs)
      );
    },
    get hopperStartupTimeoutSource() {
      if (overrides()["hopper.startup_timeout_ms"] !== undefined)
        return "runtime";
      admit("hopper.startup_timeout_ms");
      return config.hopperStartupTimeoutSource;
    },
    get ghidraDecompileTimeoutSeconds() {
      const value = overrides()["ghidra.decompile_timeout_seconds"];
      if (value !== undefined) return value === null ? undefined : value;
      admit("ghidra.decompile_timeout_seconds");
      return config.ghidraDecompileTimeoutSeconds;
    },
    get ghidraDecompileMaxPayloadMiB() {
      const value = overrides()["ghidra.decompile_max_payload_mib"];
      if (value !== undefined) return value === null ? undefined : value;
      admit("ghidra.decompile_max_payload_mib");
      return config.ghidraDecompileMaxPayloadMiB;
    },
    get ghidraValueFlowMaxOperations() {
      return (
        overrides()["ghidra.value_flow_max_operations"] ??
        (admit("ghidra.value_flow_max_operations"),
        config.ghidraValueFlowMaxOperations ??
          DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS)
      );
    },
    get ghidraValueFlowMaxInputsPerOperation() {
      return (
        overrides()["ghidra.value_flow_max_inputs_per_operation"] ??
        (admit("ghidra.value_flow_max_inputs_per_operation"),
        config.ghidraValueFlowMaxInputsPerOperation ??
          DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION)
      );
    },
    get ghidraValueFlowMaxEdges() {
      return (
        overrides()["ghidra.value_flow_max_edges"] ??
        (admit("ghidra.value_flow_max_edges"),
        config.ghidraValueFlowMaxEdges ?? DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES)
      );
    },
    regexMatchingDeadline: {
      get deadlineMs() {
        return (
          overrides()["regex.matching_deadline_ms"] ??
          (admit("regex.matching_deadline_ms"), deadline.deadlineMs)
        );
      },
      get source() {
        if (overrides()["regex.matching_deadline_ms"] !== undefined)
          return "runtime";
        admit("regex.matching_deadline_ms");
        return deadline.source;
      },
    },
    regexWorkerHeapRequest: {
      get heapMiB() {
        return (
          overrides()["regex.worker_heap_request_mib"] ??
          (admit("regex.worker_heap_request_mib"), heap.heapMiB)
        );
      },
      get source() {
        if (overrides()["regex.worker_heap_request_mib"] !== undefined)
          return "runtime";
        admit("regex.worker_heap_request_mib");
        return heap.source;
      },
    },
    hopperCallerScanBudget: {
      ...scan,
      get milliseconds() {
        return (
          overrides()["hopper.caller_scan_budget_ms"] ??
          (admit("hopper.caller_scan_budget_ms"), scan.milliseconds)
        );
      },
      get source() {
        if (overrides()["hopper.caller_scan_budget_ms"] !== undefined)
          return "runtime";
        admit("hopper.caller_scan_budget_ms");
        return scan.source;
      },
    },
    bridgeMaxRequestBytes: {
      get maximumBytes() {
        return (
          overrides()["bridge.max_request_bytes"] ??
          (admit("bridge.max_request_bytes"), bridge.maximumBytes)
        );
      },
      get source() {
        if (overrides()["bridge.max_request_bytes"] !== undefined)
          return "runtime";
        admit("bridge.max_request_bytes");
        return bridge.source;
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
  const listing = parseAsarListingAdmission(
    environment.REA_ASAR_MAX_LISTING_BYTES,
  );
  const header = () => {
    const override =
      read?.().overrides["asar.max_header_bytes"] ??
      currentAnalysisSettingOverride("asar.max_header_bytes");
    if (override !== undefined)
      return { maximumBytes: override, source: "runtime" as const };
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const expandedListing = () => {
    const override =
      read?.().overrides["asar.max_listing_bytes"] ??
      currentAnalysisSettingOverride("asar.max_listing_bytes");
    if (override !== undefined)
      return { maximumBytes: override, source: "runtime" as const };
    if (!listing.ok) throw listing.error;
    return listing.value;
  };
  if (read === undefined) return { ...header(), listing: expandedListing() };
  return {
    get maximumBytes() {
      return header().maximumBytes;
    },
    get source() {
      return header().source;
    },
    listing: {
      get maximumBytes() {
        return expandedListing().maximumBytes;
      },
      get source() {
        return expandedListing().source;
      },
    },
  };
};
export const runtimeCaptureDecoderHeap = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): CaptureDecoderHeap => {
  const parsed = parseCaptureDecoderHeap(
    environment.REA_CAPTURE_DECODER_OLD_GENERATION_MIB,
  );
  const effective = () => {
    const override =
      read?.().overrides["capture.decoder_old_generation_mib"] ??
      currentAnalysisSettingOverride("capture.decoder_old_generation_mib");
    if (override !== undefined)
      return { oldGenerationMiB: override, source: "runtime" as const };
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  if (read === undefined) return effective();
  return {
    get oldGenerationMiB() {
      return effective().oldGenerationMiB;
    },
    get source() {
      return effective().source;
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
