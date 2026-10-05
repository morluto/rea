import { HopperProtocolError } from "../domain/hopperErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

/** Authenticated identity returned by the Hopper bridge health handshake. */
export interface HopperServerInfo {
  readonly name: string;
  readonly version: string;
}

/** Validate the bridge identity and exact per-launch run identifier. */
export const parseHopperServerInfo = (
  value: JsonValue,
  expectedRunId: string,
): Result<HopperServerInfo, HopperProtocolError> => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.name === "REA Hopper bridge" &&
    typeof value.version === "string" &&
    value.run_id === expectedRunId
  )
    return ok({ name: value.name, version: value.version });
  return err(new HopperProtocolError("Hopper bridge health result is invalid"));
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
