import { z } from "zod";
import { packetFieldsSchema } from "../domain/captures/packetCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseTsharkJsonPackets } from "../pcap/TsharkJsonPackets.js";

const packetsSchema = z.array(packetFieldsSchema);

/** Why selected-field output cannot be reported; the provider attaches output. */
export interface PacketOutputFailure {
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * Read selected `-e` fields from `tshark -T json`. The producer output budget
 * already bounds the text, so no separate decoding budget applies here.
 */
export const parsePacketOutput = (
  text: string,
  packetLimit: number | null,
): Result<z.infer<typeof packetsSchema>, PacketOutputFailure> => {
  const read = parseTsharkJsonPackets(text);
  if (!read.ok)
    return err(
      read.error.kind === "malformed-json"
        ? { reason: "TShark emitted malformed JSON.", cause: read.error.cause }
        : { reason: `TShark ${read.error.reason}.` },
    );
  const parsed = packetsSchema.safeParse(read.value);
  if (!parsed.success)
    return err({
      reason: "TShark packet fields do not match the selected-field shape.",
      cause: parsed.error,
    });
  let previous = 0n;
  for (const packet of parsed.data) {
    const frame = BigInt(packet["frame.number"][0]);
    if (frame <= previous)
      return err({ reason: "TShark returned unordered frames." });
    if (packetLimit !== null && frame > BigInt(packetLimit))
      return err({
        reason:
          "TShark returned a frame beyond the selected input packet limit.",
      });
    previous = frame;
  }
  return ok(parsed.data);
};
