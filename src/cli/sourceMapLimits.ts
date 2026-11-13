import { cliDecimalField } from "./options.js";
import {
  sourceMapLimitsSchema,
  type SourceMapLimitSelection,
} from "../domain/sourceMapLimits.js";

const shape = sourceMapLimitsSchema.shape;
const sharedOptions = {
  sourceMapOutputBytes: cliDecimalField(shape.output_bytes),
  sourceMapDecodedRows: cliDecimalField(shape.decoded_rows),
  sourceMapDecodedSegments: cliDecimalField(shape.decoded_segments),
  sourceMapDecodedRecords: cliDecimalField(shape.decoded_records),
  sourceMapSectionDepth: cliDecimalField(shape.section_depth),
};
export const localSourceMapLimitCliOptions = {
  ...sharedOptions,
  sourceMapBytes: cliDecimalField(shape.map_bytes),
  sourceMapCodecHeapMib: cliDecimalField(shape.codec_heap_mib),
};
export const fetchedSourceMapLimitCliOptions = {
  ...sharedOptions,
  sourceMapFetchBytes: cliDecimalField(shape.fetch_bytes),
};
/** Keep omitted caller fields omitted in Evidence parameters. */
export const sourceMapLimitsFromCli = (options: {
  sourceMapBytes?: number | undefined;
  sourceMapOutputBytes?: number | undefined;
  sourceMapDecodedRows?: number | undefined;
  sourceMapDecodedSegments?: number | undefined;
  sourceMapDecodedRecords?: number | undefined;
  sourceMapSectionDepth?: number | undefined;
  sourceMapCodecHeapMib?: number | undefined;
  sourceMapFetchBytes?: number | undefined;
}): { source_map_limits?: SourceMapLimitSelection } => {
  const selected: SourceMapLimitSelection = {
    ...(options.sourceMapBytes === undefined
      ? {}
      : { map_bytes: options.sourceMapBytes }),
    ...(options.sourceMapOutputBytes === undefined
      ? {}
      : { output_bytes: options.sourceMapOutputBytes }),
    ...(options.sourceMapDecodedRows === undefined
      ? {}
      : { decoded_rows: options.sourceMapDecodedRows }),
    ...(options.sourceMapDecodedSegments === undefined
      ? {}
      : { decoded_segments: options.sourceMapDecodedSegments }),
    ...(options.sourceMapDecodedRecords === undefined
      ? {}
      : { decoded_records: options.sourceMapDecodedRecords }),
    ...(options.sourceMapSectionDepth === undefined
      ? {}
      : { section_depth: options.sourceMapSectionDepth }),
    ...(options.sourceMapCodecHeapMib === undefined
      ? {}
      : { codec_heap_mib: options.sourceMapCodecHeapMib }),
    ...(options.sourceMapFetchBytes === undefined
      ? {}
      : { fetch_bytes: options.sourceMapFetchBytes }),
  };
  return Object.keys(selected).length === 0
    ? {}
    : { source_map_limits: selected };
};
