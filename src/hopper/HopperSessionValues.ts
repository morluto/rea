import { DEFAULT_BRIDGE_MAX_REQUEST_BYTES } from "../domain/analysisResourceLimits.js";
import { HopperProtocolError } from "../domain/hopperErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { hopperReplySchemas } from "./HopperReplyContracts.js";

/** Bound cleanup handshakes and the bridge's idle reconnection wait. */
export const HOPPER_SHUTDOWN_TIMEOUT_MS = 30_000;

/** Authenticated identity returned by the Hopper bridge health handshake. */
export interface HopperServerInfo {
  readonly name: string;
  readonly version: string;
  readonly processId: number;
  /** Bridge request ceiling. An omitted health field means the 16 MiB default. */
  readonly maxRequestBytes: number;
}

/**
 * Read the bridge identity through the `health` reply contract, then bind it
 * to this launch's exact run identifier.
 */
export const parseHopperServerInfo = (
  value: JsonValue,
  expectedRunId: string,
): Result<HopperServerInfo, HopperProtocolError> => {
  const parsed = hopperReplySchemas.health.safeParse(value);
  if (!parsed.success || parsed.data.run_id !== expectedRunId)
    return err(
      new HopperProtocolError(
        "Hopper bridge health result is invalid",
        parsed.success ? {} : { cause: parsed.error },
      ),
    );
  const health = parsed.data;
  return ok({
    name: health.name,
    version: health.version,
    processId: health.process_id,
    maxRequestBytes:
      health.max_request_bytes ?? DEFAULT_BRIDGE_MAX_REQUEST_BYTES,
  });
};

/** Require confirmation that the REA bridge detached or its document closed. */
export const isHopperShutdownAcknowledgement = (value: JsonValue): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  if (value.shutdown !== true) return false;
  return (
    (value.analysis_stopped === true && value.document_closed === true) ||
    (value.document_closed === false && value.document_retained === true)
  );
};

/** Detect the verified Linux bridge response that requires group cleanup. */
export const isHopperCleanupRequired = (value: JsonValue): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value.shutdown === true &&
  value.cleanup_required === true;
