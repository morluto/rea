import type { FileHandle } from "node:fs/promises";
import type { z } from "zod";
import { decodeBytePattern } from "../../domain/native/bytePattern.js";
import {
  HEX_DUMP_LINE_BYTES,
  formatHexDump,
  type searchRawBytesInputSchema,
} from "../../domain/native/rawBytes.js";
import type { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";

/** Bytes read from the file per physical scan step; matches may straddle two steps. */
export const RAW_BYTES_SCAN_CHUNK_BYTES = 65_536;

/** Facts about the admitted file that one operation reads from. */
export interface AdmittedFile {
  readonly file: FileHandle;
  readonly size: number;
  readonly signal: AbortSignal | undefined;
  readonly invalid: (field: string, message: string) => AnalysisInputError;
  /** Fill exactly `length` bytes at `position`; a premature EOF means the file changed. */
  readonly readExactly: (
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    position: number,
  ) => Promise<void>;
}

export interface PatternScan {
  readonly offsets: readonly number[];
  readonly patternBytes: number;
  /** First unreturned match, when the page limit stopped the scan. */
  readonly nextOffset: number | null;
}

/**
 * Stream the file from `start_offset`, keeping the last `pattern - 1` bytes of
 * every step so a match that straddles two physical reads is still found. Each
 * start position is tested exactly once.
 */
export const scanForPattern = async (
  admitted: AdmittedFile,
  input: z.infer<typeof searchRawBytesInputSchema>,
): Promise<PatternScan> => {
  const { value, mask } = decodeBytePattern(input);
  const length = value.length;
  // The validated pattern constrains at least one bit; anchor the scan on its
  // first constrained byte so unconstrained leading bytes cost nothing extra.
  const anchor = mask.findIndex((selected) => selected !== 0);
  const anchorExact = mask[anchor] === 0xff;
  const buffer = Buffer.alloc(RAW_BYTES_SCAN_CHUNK_BYTES + length - 1);
  const offsets: number[] = [];
  let nextOffset: number | null = null;
  let carried = 0;
  let bufferBase = input.start_offset;
  let position = input.start_offset;
  while (position < admitted.size) {
    assertArtifactReadActive(admitted.signal);
    const wanted = Math.min(
      RAW_BYTES_SCAN_CHUNK_BYTES,
      admitted.size - position,
    );
    await admitted.readExactly(buffer, carried, wanted, position);
    position += wanted;
    const filled = carried + wanted;
    const lastStart = filled - length;
    const view = buffer.subarray(0, filled);
    for (let start = 0; start <= lastStart; start += 1) {
      if (anchorExact) {
        const next = view.indexOf(value[anchor]!, start + anchor);
        if (next < 0 || next - anchor > lastStart) break;
        start = next - anchor;
      }
      let matched = true;
      for (let index = 0; index < length; index += 1)
        if ((buffer[start + index]! & mask[index]!) !== value[index]!) {
          matched = false;
          break;
        }
      if (!matched) continue;
      const offset = bufferBase + start;
      if (offsets.length === input.max_matches) {
        nextOffset = offset;
        return { offsets, patternBytes: length, nextOffset };
      }
      offsets.push(offset);
    }
    const keep = Math.min(length - 1, filled);
    buffer.copyWithin(0, filled - keep, filled);
    bufferBase += filled - keep;
    carried = keep;
  }
  return { offsets, patternBytes: length, nextOffset };
};

/** Hex-dump the aligned lines covering a match plus `contextLines` on each side. */
export const matchContext = async (
  admitted: AdmittedFile,
  offset: number,
  patternBytes: number,
  contextLines: number,
): Promise<string> => {
  const line = HEX_DUMP_LINE_BYTES;
  const start = Math.max(
    0,
    Math.floor(offset / line) * line - contextLines * line,
  );
  const end = Math.min(
    admitted.size,
    (Math.floor((offset + patternBytes - 1) / line) + 1 + contextLines) * line,
  );
  const bytes = Buffer.alloc(end - start);
  await admitted.readExactly(bytes, 0, bytes.length, start);
  return formatHexDump(bytes, start);
};
