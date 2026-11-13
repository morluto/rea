import { z } from "zod";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { packetFieldsSchema } from "../domain/captures/packetCapture.js";

// _index/_score are TShark export metadata, not captured packet fields.
const producerSchema = z.array(
  z.object({ _source: z.object({ layers: packetFieldsSchema }) }),
);
export const parsePacketOutput = (text: string, packetLimit: number | null) => {
  const decoded: unknown = JSON.parse(text);
  const packets = producerSchema
    .parse(decoded)
    .map((packet) => packet._source.layers);
  let previous = 0n;
  for (const packet of packets) {
    const frame = BigInt(packet["frame.number"][0]);
    if (frame <= previous)
      throw new AnalysisOutputError(
        "inspect_packet_capture",
        "TShark returned unordered frames.",
      );
    if (packetLimit !== null && frame > BigInt(packetLimit))
      throw new AnalysisOutputError(
        "inspect_packet_capture",
        "TShark returned a frame beyond the selected input packet limit.",
      );
    previous = frame;
  }
  return packets;
};
