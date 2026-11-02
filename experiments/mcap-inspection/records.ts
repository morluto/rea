import { McapByteReader, parseRecord } from "@mcap/core";
import { diagnostic, InspectionFailure } from "./limits.ts";

export function validateSummaryRecords(data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < data.byteLength) {
    try {
      if (data.byteLength - offset < 9)
        throw new Error("Truncated record header");
      const length = view.getBigUint64(offset + 1, true);
      if (length > BigInt(data.byteLength - offset - 9))
        throw new Error("Record extends beyond the summary");
      const frameBytes = 9 + Number(length);
      const frame = new DataView(
        data.buffer,
        data.byteOffset + offset,
        frameBytes,
      );
      if (parseRecord(new McapByteReader(frame), true) === undefined)
        throw new Error("Incomplete record");
      offset += frameBytes;
    } catch (cause) {
      throw new InspectionFailure(
        "reader_rejected",
        `Invalid summary record boundary at byte ${offset}: ${diagnostic(cause).message}`,
      );
    }
  }
}
