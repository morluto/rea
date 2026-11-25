import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isRecord } from "../../kernel/isRecord.js";
import { parseJsonWithDuplicatePolicy } from "../jsonDuplicateMember.js";
import { err, ok, type Result } from "../result.js";

/**
 * One `tshark -T json` packet's `_source.layers` record. Export metadata
 * (`_index`, `_score`) is not packet data and is dropped here.
 */
export type TsharkPacketLayers = Record<string, unknown>;

/**
 * Bounds on reading one `tshark -T json` document. `maxBytes` admits the
 * UTF-8 text; `maxDecodedBytes` bounds a conservative estimate of the object
 * graph `JSON.parse` would build, checked before parsing. `decodedBytes` is
 * shared across the acquisitions of one inspection.
 */
export interface TsharkJsonBudget {
  readonly maxBytes: number;
  readonly maxDecodedBytes: number;
  decodedBytes: number;
}

/** Why a `tshark -T json` document is not a packet array. */
export type TsharkJsonEnvelopeFailure =
  | { readonly kind: "malformed-json"; readonly cause: unknown }
  | { readonly kind: "malformed-packet"; readonly reason: string };

/** Why a budgeted read of a `tshark -T json` document stopped. */
export type TsharkJsonFailure =
  | TsharkJsonEnvelopeFailure
  | { readonly kind: "cancelled"; readonly cause: unknown }
  | { readonly kind: "json-bytes"; readonly maxBytes: number }
  | { readonly kind: "json-expansion"; readonly maxDecodedBytes: number };

const YIELD_INTERVAL = 65_536;

/**
 * Estimate the expanded graph of `text` and stop when it exceeds the budget.
 * The estimate charges every string, container and member separator before
 * `JSON.parse` allocates them.
 */
const chargeExpansion = async (
  text: string,
  budget: TsharkJsonBudget,
  signal: AbortSignal | undefined,
): Promise<TsharkJsonFailure | undefined> => {
  let quoted = false;
  let escaped = false;
  let decodedBytes = budget.decodedBytes + text.length * 2;
  const maxDecodedBytes = budget.maxDecodedBytes;
  if (decodedBytes > maxDecodedBytes) {
    budget.decodedBytes = decodedBytes;
    return { kind: "json-expansion", maxDecodedBytes };
  }
  const len = text.length;
  for (let start = 0; start < len; start += YIELD_INTERVAL) {
    await yieldToEventLoop();
    if (signal?.aborted) {
      budget.decodedBytes = decodedBytes;
      return { kind: "cancelled", cause: signal.reason };
    }
    const end = Math.min(start + YIELD_INTERVAL, len);
    for (let index = start; index < end; index += 1) {
      const code = text.charCodeAt(index);
      if (quoted) {
        if (escaped) escaped = false;
        else if (code === 0x5c) escaped = true;
        else if (code === 0x22) quoted = false;
      } else if (code === 0x22) {
        quoted = true;
        decodedBytes += 64;
      } else if (
        code === 0x7b ||
        code === 0x5b ||
        code === 0x3a ||
        code === 0x2c
      ) {
        decodedBytes += 128;
      }
      if (decodedBytes > maxDecodedBytes) {
        budget.decodedBytes = decodedBytes;
        return { kind: "json-expansion", maxDecodedBytes };
      }
    }
  }
  budget.decodedBytes = decodedBytes;
  return undefined;
};

/**
 * Parse a `tshark -T json` document as the ordered `_source.layers` record of
 * each packet. This owns the export envelope; interpreting the layers (flat
 * `-e` fields or a protocol tree) belongs to the caller. The caller has
 * already bounded `text`; `readTsharkJsonPackets` also bounds its expansion.
 */
export const parseTsharkJsonPackets = (
  text: string,
): Result<TsharkPacketLayers[], TsharkJsonEnvelopeFailure> => {
  // Both tshark callers pass `--no-duplicate-keys`, so tshark merges repeated
  // protocol and field names into arrays before REA parses the JSON document.
  const parsed = parseJsonWithDuplicatePolicy(text, "last-wins");
  if (!parsed.ok) return err({ kind: "malformed-json", cause: parsed.cause });
  const decoded = parsed.value;
  if (!Array.isArray(decoded))
    return err({
      kind: "malformed-packet",
      reason: "packet root must be an array",
    });
  const packets: TsharkPacketLayers[] = [];
  for (let index = 0; index < decoded.length; index += 1) {
    const packet = decoded[index];
    if (
      !isRecord(packet) ||
      !isRecord(packet._source) ||
      !isRecord(packet._source.layers)
    )
      return err({
        kind: "malformed-packet",
        reason: `packet ${String(index + 1)} lacks _source.layers`,
      });
    packets.push(packet._source.layers);
  }
  return ok(packets);
};

/**
 * Admit a `tshark -T json` document against its byte and expansion budget,
 * yielding to the event loop and observing `signal` while estimating, then
 * parse it with `parseTsharkJsonPackets`.
 */
export const readTsharkJsonPackets = async (
  text: string,
  budget: TsharkJsonBudget,
  signal?: AbortSignal,
): Promise<Result<TsharkPacketLayers[], TsharkJsonFailure>> => {
  if (signal?.aborted) return err({ kind: "cancelled", cause: signal.reason });
  if (Buffer.byteLength(text) > budget.maxBytes)
    return err({ kind: "json-bytes", maxBytes: budget.maxBytes });
  const refused = await chargeExpansion(text, budget, signal);
  if (refused !== undefined) return err(refused);
  return parseTsharkJsonPackets(text);
};
