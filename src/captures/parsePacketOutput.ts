import { z } from "zod";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { packetFieldsSchema } from "../domain/captures/packetCapture.js";
import { parseTsharkJsonPackets } from "../pcap/TsharkJsonPackets.js";

const OPERATION = "inspect_packet_capture";
const packetsSchema = z.array(packetFieldsSchema);

/**
 * Read selected `-e` fields from `tshark -T json`. The producer output budget
 * already bounds the text, so no separate decoding budget applies here.
 */
export const parsePacketOutput = (text: string, packetLimit: number | null) => {
  const read = parseTsharkJsonPackets(text);
  if (!read.ok) {
    const failure = read.error;
    switch (failure.kind) {
      case "malformed-json":
        throw new AnalysisOutputError(
          OPERATION,
          "TShark emitted malformed JSON.",
          {
            cause: failure.cause,
          },
        );
      case "malformed-packet":
        throw new AnalysisOutputError(OPERATION, `TShark ${failure.reason}.`);
    }
  }
  const packets = packetsSchema.parse(read.value);
  let previous = 0n;
  for (const packet of packets) {
    const frame = BigInt(packet["frame.number"][0]);
    if (frame <= previous)
      throw new AnalysisOutputError(
        OPERATION,
        "TShark returned unordered frames.",
      );
    if (packetLimit !== null && frame > BigInt(packetLimit))
      throw new AnalysisOutputError(
        OPERATION,
        "TShark returned a frame beyond the selected input packet limit.",
      );
    previous = frame;
  }
  return packets;
};
