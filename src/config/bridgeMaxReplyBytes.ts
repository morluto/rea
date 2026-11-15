import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";

import {
  DEFAULT_BRIDGE_MAX_REPLY_BYTES,
  MAXIMUM_BRIDGE_MAX_REPLY_BYTES,
  MINIMUM_BRIDGE_MAX_REPLY_BYTES,
} from "../domain/analysisResourceLimits.js";

export const BRIDGE_MAX_REPLY_BYTES_SETTING = "REA_BRIDGE_MAX_REPLY_BYTES";

/**
 * Largest Hopper or Ghidra reply line REA reads, in UTF-8 bytes before the LF.
 *
 * Measured 2026-11-14 over the fake-bridge client tests (ghidraClient,
 * ghidraTransport, ghidraInventoryMcp, ghidraReopen, hopperClient.progress,
 * hopperRegexFailure, hopperBridgeRequestLimit): 287 reply lines. Apart from
 * two deliberate stress replies, the largest was a 1466-byte handshake. The
 * stress replies are a 16 MiB Hopper echo and the largest inventory reply, a
 * 67109019-byte Ghidra `list_strings` page holding one 64 MiB string. The
 * 256 MiB default keeps four times that headroom while bounding what a
 * misbehaving bridge can make REA retain.
 */
export interface BridgeMaxReplyBytes {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_BRIDGE_MAX_REPLY: BridgeMaxReplyBytes = {
  maximumBytes: DEFAULT_BRIDGE_MAX_REPLY_BYTES,
  source: "default",
};

/**
 * Copy the effective ceiling when a request is admitted. Socket reads run
 * outside the request's async context, where a runtime override is not
 * visible, so each request carries the value it admitted and the reader
 * enforces it only while that request is the one on the wire.
 */
export const admitBridgeReplyLimit = (
  limit: BridgeMaxReplyBytes,
): BridgeMaxReplyBytes => ({
  maximumBytes: limit.maximumBytes,
  source: limit.source,
});

/** Bridges whose replies the shared JSON-line reader bounds. */
export type BridgeReplyPeer = "Hopper" | "Ghidra";

const bridgeMaxReplyBytesConstraint = `${BRIDGE_MAX_REPLY_BYTES_SETTING} must be a positive decimal integer from ${String(MINIMUM_BRIDGE_MAX_REPLY_BYTES)} to ${String(MAXIMUM_BRIDGE_MAX_REPLY_BYTES)} bytes; the default is ${String(DEFAULT_BRIDGE_MAX_REPLY_BYTES)} bytes (256 MiB). A value below ${String(MINIMUM_BRIDGE_MAX_REPLY_BYTES)} bytes cannot carry a bridge handshake or a full inventory page, and a larger value cannot be decoded as one string.`;

/** Optional decimal byte count for the Hopper and Ghidra reply line ceiling. */
export const bridgeMaxReplyBytesSchema = positiveDecimalIntegerSchema(
  MINIMUM_BRIDGE_MAX_REPLY_BYTES,
  MAXIMUM_BRIDGE_MAX_REPLY_BYTES,
  bridgeMaxReplyBytesConstraint,
);

const bridgeMaxReplyBytesRecovery = (limit: BridgeMaxReplyBytes): string =>
  `The effective bridge.max_reply_bytes value is ${String(limit.maximumBytes)} bytes (source ${limit.source}; default ${String(DEFAULT_BRIDGE_MAX_REPLY_BYTES)}, floor ${String(MINIMUM_BRIDGE_MAX_REPLY_BYTES)}, maximum ${String(MAXIMUM_BRIDGE_MAX_REPLY_BYTES)}). Request a smaller page or narrower selection, or raise it with update_analysis_settings; the launch seed is ${BRIDGE_MAX_REPLY_BYTES_SETTING}. REA closed that bridge connection instead of retaining the reply, so the provider session must start again before its next request.`;

/** Refuse one reply line that exceeds the effective ceiling; nothing past it was kept. */
export const bridgeReplyOversizeError = (
  peer: BridgeReplyPeer,
  limit: BridgeMaxReplyBytes,
  observedBytes: number,
): AnalysisResourceConstraintError => {
  const recovery = bridgeMaxReplyBytesRecovery(limit);
  return new AnalysisResourceConstraintError(
    `${peer.toLowerCase()}_bridge_reply`,
    "transport",
    `${peer} bridge reply exceeded the ${String(limit.maximumBytes)}-byte reply limit: one reply line reached ${String(observedBytes)} bytes, and REA stopped reading it. ${recovery}`,
    { max_reply_bytes: limit.maximumBytes, observed_bytes: observedBytes },
    {
      remediationAction: recovery,
      retryable: false,
      limit: analysisSettingLimit(
        "bridge.max_reply_bytes",
        limit.maximumBytes,
        limit.source,
      ),
    },
  );
};
