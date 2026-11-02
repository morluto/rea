import { createHash } from "node:crypto";
import { McapIndexedReader, Opcode } from "@mcap/core";
import type { IReadable } from "@mcap/core";
import { err, ok } from "../../src/domain/result.js";
import { validateSummaryRecords } from "./records.ts";
import {
  BoundedReadable,
  boundedJson,
  diagnostic,
  InspectionFailure,
  OUTPUT_BYTES,
  READ_BYTES,
} from "./limits.ts";

function summarize(reader: McapIndexedReader, schemaId?: number) {
  if (schemaId !== undefined && !reader.schemasById.has(schemaId))
    throw new InspectionFailure(
      "selection",
      `Schema ${schemaId} is not available in the summary`,
    );
  const selected =
    schemaId === undefined ? undefined : reader.schemasById.get(schemaId);
  if (
    selected !== undefined &&
    4 * Math.ceil(selected.data.byteLength / 3) > OUTPUT_BYTES
  )
    throw new InspectionFailure(
      "limit",
      "Selected schema would exceed the JSON budget after base64 encoding",
    );
  const stats = reader.statistics;
  return {
    experimental: true,
    reader: "@mcap/core@2.3.0",
    coverage: {
      scope: "header_and_summary",
      data_section: "not_scanned",
      whole_file_validity: "not_established",
      cross_references: "not_verified",
      duplicate_record_ids: "not_checked_reader_maps_keep_last",
      summary_crc:
        reader.footer.summaryCrc === 0 ? "not_present" : "verified_by_reader",
      schema_content: schemaId === undefined ? "omitted" : "selected_base64",
      limits: { cumulative_read_bytes: READ_BYTES, json_bytes: OUTPUT_BYTES },
    },
    header: { profile: reader.header.profile, library: reader.header.library },
    declared_statistics:
      stats === undefined
        ? null
        : {
            message_count: String(stats.messageCount),
            message_start_time_ns: String(stats.messageStartTime),
            message_end_time_ns: String(stats.messageEndTime),
            schema_count: stats.schemaCount,
            channel_count: stats.channelCount,
            chunk_count: stats.chunkCount,
            attachment_count: stats.attachmentCount,
            metadata_count: stats.metadataCount,
          },
    channels: [...reader.channelsById.values()].map((channel) => ({
      id: channel.id,
      topic: channel.topic,
      message_encoding: channel.messageEncoding,
      schema_id: channel.schemaId,
      schema_in_summary:
        channel.schemaId === 0
          ? null
          : reader.schemasById.has(channel.schemaId),
      message_count:
        stats?.channelMessageCounts.get(channel.id)?.toString() ?? null,
      metadata: Object.fromEntries(channel.metadata),
    })),
    schemas: [...reader.schemasById.values()].map((schema) => ({
      id: schema.id,
      name: schema.name,
      encoding: schema.encoding,
      byte_length: schema.data.byteLength,
      sha256: createHash("sha256").update(schema.data).digest("hex"),
      data_base64:
        schema.id === schemaId
          ? Buffer.from(schema.data).toString("base64")
          : null,
    })),
    chunk_indexes: reader.chunkIndexes.map((chunk) => ({
      offset: String(chunk.chunkStartOffset),
      byte_length: String(chunk.chunkLength),
      compression: chunk.compression,
      compressed_bytes: String(chunk.compressedSize),
      uncompressed_bytes: String(chunk.uncompressedSize),
      message_start_time_ns: String(chunk.messageStartTime),
      message_end_time_ns: String(chunk.messageEndTime),
    })),
  };
}

export async function inspectSummary(source: IReadable, schemaId?: number) {
  const readable = new BoundedReadable(source);
  try {
    const reader = await McapIndexedReader.Initialize({
      readable: {
        size: () => readable.size(),
        read: async (offset, size) => {
          const data = await readable.read(offset, size);
          // The pinned reader requests DataEnd and the summary together. Its parser
          // otherwise lets fields consume bytes beyond their individual record.
          if (data[0] === Opcode.DATA_END) validateSummaryRecords(data);
          return data;
        },
      },
    });
    const report = {
      ...summarize(reader, schemaId),
      read_ranges: readable.reads,
    };
    boundedJson(report);
    return ok(report);
  } catch (cause) {
    return err({
      ...diagnostic(cause),
      read_ranges: readable.reads,
    });
  }
}
