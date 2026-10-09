import { constants } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import streamValues from "stream-json/streamers/stream-values.js";

import { withRegularFile } from "./application/RegularFileRead.js";
import { parseUtf8Json } from "./application/Utf8JsonInput.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./domain/analysisErrorCore.js";
import { err, ok, type Result } from "./domain/result.js";

type JsonFileFailure = AnalysisInputError | AnalysisResourceConstraintError;
const READ_CHUNK_BYTES = 64 * 1024;
// Retain native-parser speed for modest inputs while bounding its extra copies.
// This selects an implementation; larger files remain accepted through streaming.
const NATIVE_PARSE_READ_BUDGET = 8 * 1024 * 1024;

/** Parse strict UTF-8 JSON without requiring a whole-document string. */
export const readCliJsonFile = (
  path: string,
  operation: string,
  signal?: AbortSignal,
): Promise<Result<unknown, JsonFileFailure>> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      let found = false;
      let value: unknown;
      try {
        const prefix =
          stats.size <= NATIVE_PARSE_READ_BUDGET
            ? await readPrefix(handle, stats.size + 1, signal)
            : undefined;
        if (prefix?.complete === true) {
          const parsed = parseUtf8Json(prefix.bytes, operation, path);
          return parsed.ok
            ? ok(parsed.value)
            : err(invalidJson(operation, parsed.error, parsed.cause));
        }
        await pipeline(
          decodedChunks(handle, signal, prefix?.bytes),
          streamValues.withParserAsStream({
            jsonStreaming: false,
            streamValues: false,
          }),
          async (rows: AsyncIterable<unknown>) => {
            for await (const row of rows) {
              if (
                found ||
                typeof row !== "object" ||
                row === null ||
                !("key" in row) ||
                row.key !== 0 ||
                !("value" in row)
              )
                throw new Error("Unexpected JSON parser result");
              found = true;
              value = row.value;
            }
          },
          signal === undefined ? {} : { signal },
        );
        return found
          ? ok(value)
          : err(invalidJson(operation, "JSON document is empty"));
      } catch (cause: unknown) {
        if (
          cause instanceof TypeError &&
          "code" in cause &&
          cause.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
        )
          return err(
            invalidJson(operation, "JSON input is not valid UTF-8", cause),
          );
        if (
          cause instanceof SyntaxError ||
          (cause instanceof Error && cause.message.startsWith("Parser "))
        )
          return err(invalidJson(operation, cause.message, cause));
        if (
          cause instanceof Error &&
          ((cause instanceof RangeError &&
            cause.message === "Invalid string length") ||
            ("code" in cause && cause.code === "ERR_STRING_TOO_LONG"))
        )
          return err(
            new AnalysisResourceConstraintError(
              operation,
              "memory",
              "An individual JSON string exceeds the runtime string limit",
              {
                input_file_bytes: stats.size,
                max_string_code_units: constants.MAX_STRING_LENGTH,
              },
              {
                cause,
                remediationAction:
                  "Select a smaller Evidence view or split the oversized JSON string. Streaming removes the whole-document string limit, but individual strings still follow the runtime limit.",
              },
            ),
          );
        throw cause;
      }
    },
    signal,
  );

async function* decodedChunks(
  handle: FileHandle,
  signal: AbortSignal | undefined,
  prefix?: Uint8Array,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (prefix !== undefined)
    for (let offset = 0; offset < prefix.length; offset += READ_CHUNK_BYTES) {
      signal?.throwIfAborted();
      yield decoder.decode(prefix.subarray(offset, offset + READ_CHUNK_BYTES), {
        stream: true,
      });
    }
  const bytes = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  while (true) {
    signal?.throwIfAborted();
    const read = await handle.read(bytes, 0, bytes.length, null);
    signal?.throwIfAborted();
    if (read.bytesRead === 0) break;
    yield decoder.decode(bytes.subarray(0, read.bytesRead), { stream: true });
  }
  yield decoder.decode();
}

const readPrefix = async (
  handle: FileHandle,
  size: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly bytes: Buffer; readonly complete: boolean }> => {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const read = await handle.read(bytes, offset, bytes.length - offset, null);
    signal?.throwIfAborted();
    if (read.bytesRead === 0)
      return { bytes: bytes.subarray(0, offset), complete: true };
    offset += read.bytesRead;
  }
  // The file grew after admission. Continue from this same handle, preserving
  // the prefix already read rather than reopening or dropping its bytes.
  return { bytes, complete: false };
};

const invalidJson = (
  operation: string,
  message: string,
  cause?: unknown,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    cause === undefined ? undefined : { cause },
    [{ path: [], reason: "invalid_format", expected: "JSON", message }],
  );
