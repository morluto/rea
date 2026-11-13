import { err, ok } from "../domain/result.js";
import type { z } from "zod";
import type { AnalysisSettingId } from "../domain/analysisSettings.js";
import {
  ANALYSIS_SETTINGS,
  analysisSettingDefinition,
} from "../domain/analysisSettingDefinitions.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { asarMaxHeaderBytesSchema } from "./asarHeaderAdmission.js";
import { asarMaxListingBytesSchema } from "./asarListingAdmission.js";
import {
  ghidraValueFlowCountSchema,
  ghidraDecompilePayloadMiBSchema,
} from "./ghidraValueFlowLimits.js";
import {
  providerStartupTimeoutSchema,
  ghidraDecompileTimeoutSchema,
} from "./providerStartupTimeout.js";
import { regexMatchingDeadlineMsSchema } from "./regexMatchingDeadline.js";
import { regexWorkerHeapRequestMiBSchema } from "./regexWorkerHeapRequest.js";
import { captureDecoderOldGenerationMiBSchema } from "./captureDecoderHeap.js";
import { parseNativeMatchingAllowance } from "./nativeMatchingAllowance.js";
import { bridgeMaxRequestBytesSchema } from "./bridgeMaxRequestBytes.js";
import {
  debuggerCommandDeadlineMsSchema,
  debuggerMaxCommandOutputBytesSchema,
} from "./debuggerSessionLimits.js";
import {
  windowsChangeTimeDriftMsSchema,
  windowsChangeTimeSettleMaxPollsSchema,
  windowsChangeTimeSettlePollMsSchema,
} from "./windowsChangeTimeSettle.js";
import { pwntoolsInputBytesSchema } from "../native/pwntools/PwntoolsInputLimit.js";
const environmentSchemas: Readonly<Record<string, z.ZodType<number, string>>> =
  {
    REA_ASAR_MAX_HEADER_BYTES: asarMaxHeaderBytesSchema,
    REA_ASAR_MAX_LISTING_BYTES: asarMaxListingBytesSchema,
    REA_GHIDRA_VALUE_FLOW_MAX_OPERATIONS: ghidraValueFlowCountSchema,
    REA_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION: ghidraValueFlowCountSchema,
    REA_GHIDRA_VALUE_FLOW_MAX_EDGES: ghidraValueFlowCountSchema,
    REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB: ghidraDecompilePayloadMiBSchema,
    REA_GHIDRA_STARTUP_TIMEOUT_MS: providerStartupTimeoutSchema,
    REA_HOPPER_STARTUP_TIMEOUT_MS: providerStartupTimeoutSchema,
    REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: ghidraDecompileTimeoutSchema,
    REA_JADX_OPERATION_TIMEOUT_MS: providerStartupTimeoutSchema,
    REA_REGEX_MATCHING_DEADLINE_MS: regexMatchingDeadlineMsSchema,
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: regexWorkerHeapRequestMiBSchema,
    REA_CAPTURE_DECODER_OLD_GENERATION_MIB:
      captureDecoderOldGenerationMiBSchema,
    REA_BRIDGE_MAX_REQUEST_BYTES: bridgeMaxRequestBytesSchema,
    REA_DEBUGGER_COMMAND_DEADLINE_MS: debuggerCommandDeadlineMsSchema,
    REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES: debuggerMaxCommandOutputBytesSchema,
    REA_HOPPER_CALLER_SCAN_BUDGET_MS: providerStartupTimeoutSchema,
    REA_JEB_MCP_TIMEOUT_MS: providerStartupTimeoutSchema,
    REA_KUNA_PROJECT_TIMEOUT_MS: providerStartupTimeoutSchema,
    REA_KUNA_TIMEOUT_MS: providerStartupTimeoutSchema,
    REA_PWNTOOLS_MAX_INPUT_BYTES: pwntoolsInputBytesSchema,
    REA_WINDOWS_CHANGE_TIME_DRIFT_MS: windowsChangeTimeDriftMsSchema,
    REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS: windowsChangeTimeSettlePollMsSchema,
    REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS:
      windowsChangeTimeSettleMaxPollsSchema,
  };
export const launchAnalysisSetting = (
  id: AnalysisSettingId,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  if (id === "native.matching_representation_bytes") {
    const parsed = parseNativeMatchingAllowance(environment);
    return parsed.ok
      ? ok({ value: parsed.value.maximumBytes, source: parsed.value.source })
      : parsed;
  }
  const definition = analysisSettingDefinition(id);
  const raw =
    definition.environment === undefined
      ? undefined
      : environment[definition.environment];
  if (raw === undefined)
    return ok({ value: definition.defaultValue, source: "default" as const });
  const parsed = environmentSchemas[definition.environment!]?.safeParse(raw);
  if (parsed?.success !== true)
    return err(
      new ConfigurationError(`Invalid ${definition.environment}`, {
        settings: [
          {
            setting: definition.environment!,
            constraint: `Expected an integer from ${definition.minimum} to ${definition.maximum} ${definition.unit}`,
          },
        ],
      }),
    );
  return ok({ value: parsed.data, source: "setting" as const });
};

/** Inspect explicit launch seeds for diagnostics and registration without changing lazy runtime admission. */
export const inspectAnalysisSettingSeeds = (
  environment: Readonly<Record<string, string | undefined>>,
  unresolvedSettings: ReadonlySet<string> = new Set(),
) =>
  Object.keys(ANALYSIS_SETTINGS).flatMap((key) => {
    const id = key as AnalysisSettingId;
    const definition = analysisSettingDefinition(id);
    if (
      definition.environment === undefined ||
      unresolvedSettings.has(definition.environment)
    )
      return [];
    const parsed = launchAnalysisSetting(id, environment);
    return parsed.ok ? [] : parsed.error.settings;
  });
