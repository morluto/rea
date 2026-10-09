import { constants } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import streamValues from "stream-json/streamers/stream-values.js";

import { withRegularFile } from "./application/RegularFileRead.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./domain/analysisErrorCore.js";
import { err, ok, type Result } from "./domain/result.js";

type JsonFileFailure = AnalysisInputError | AnalysisResourceConstraintError;

/** Parse a strict UTF-8 JSON file without retaining a whole-file buffer or string. */
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
        await pipeline(
          decodedChunks(handle, signal),
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
        if (cause instanceof Error && cause.message.startsWith("Parser "))
          return err(invalidJson(operation, cause.message, cause));
        if (
          cause instanceof RangeError &&
          (cause.message === "Invalid string length" ||
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
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const bytes = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    signal?.throwIfAborted();
    const read = await handle.read(bytes, 0, bytes.length, null);
    signal?.throwIfAborted();
    if (read.bytesRead === 0) break;
    yield decoder.decode(bytes.subarray(0, read.bytesRead), { stream: true });
  }
  yield decoder.decode();
}

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
