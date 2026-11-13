import type { AdbDeviceAnalysisPort } from "./AdbDeviceAnalysisPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import {
  adbRequestSchema,
  adbDeviceListObservationSchema,
  type AdbOperation,
} from "../../domain/adb/adbDeviceAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for ADB. */
export class AdbDeviceAnalysisService {
  constructor(readonly provider: AdbDeviceAnalysisPort) {}

  /** Run one caller-selected ADB request and retain device provenance inline. */
  async execute(
    operation: AdbOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      adbRequestSchema,
      {
        execute: async (request, options) => {
          const result = await this.provider.execute(request, options);
          return result.ok && request.operation === "list_adb_devices"
            ? projectDeviceList(result.value)
            : result;
        },
      },
      "observed",
    );
  }
}

/** Public number compatibility is a projection of exact provider facts, never identity admission. */
const projectDeviceList = (
  execution: AnalysisExecution,
): Result<AnalysisExecution, AnalysisError> => {
  const json = jsonValueSchema.safeParse(execution.result);
  const parsed = json.success
    ? adbDeviceListObservationSchema.safeParse(json.data)
    : json;
  if (!parsed.success)
    return err(
      new AnalysisOutputError(
        "list_adb_devices",
        "ADB provider returned malformed device-list identity facts.",
        { cause: parsed.error },
      ),
    );
  let numericUnavailable = false;
  let invalidIdentity = false;
  const devices = parsed.data.devices.map(
    ({ transport_identity, ...device }) => {
      const text =
        transport_identity.status === "reported"
          ? transport_identity.decimal
          : null;
      const safe =
        text !== null &&
        (text.length < 16 ||
          (text.length === 16 && text <= "9007199254740991"));
      if (text !== null && !safe) numericUnavailable = true;
      if (transport_identity.status === "invalid") invalidIdentity = true;
      return {
        ...device,
        transport_id: safe ? Number(text) : null,
        transport_id_text: text,
        transport_id_status: transport_identity.status,
      };
    },
  );
  return ok({
    ...execution,
    result: { ...parsed.data, devices },
    rawResult: {
      ...(execution.rawResult === null
        ? {}
        : { provider_raw_result: execution.rawResult }),
      transport_id_observations: parsed.data.devices.map(
        ({ serial, transport_identity }, row) => ({
          row,
          serial,
          source_line: transport_identity.source_line,
          source_token: transport_identity.source_token,
          status: transport_identity.status,
          reason:
            transport_identity.status === "invalid"
              ? transport_identity.reason
              : transport_identity.status === "not_reported"
                ? "not_reported"
                : null,
        }),
      ),
    },
    limitations: [
      ...execution.limitations,
      ...(numericUnavailable
        ? [
            "A reported transport ID cannot be represented as a safe JSON integer. transport_id_text retains its exact identity; existing operations select the device by serial.",
          ]
        : []),
      ...(invalidIdentity
        ? [
            "Some transport ID fields were invalid. Known device facts remain available; raw_result.transport_id_observations retains source tokens and reasons.",
          ]
        : []),
    ],
  });
};
