import { constants } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { getHeapStatistics } from "node:v8";

import parser from "stream-json/parser.js";
import streamValues from "stream-json/streamers/stream-values.js";

import { withRegularFile } from "./application/RegularFileRead.js";
import {
  JSON_INPUT_RESOURCE_REMEDIATION,
  parseUtf8Json,
} from "./application/Utf8JsonInput.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./domain/analysisErrorCore.js";
import { err, ok, type Result } from "./domain/result.js";

type JsonFileFailure = AnalysisInputError | AnalysisResourceConstraintError;
const READ_CHUNK_BYTES = 64 * 1024;
const PACKED_STRING_PART_CODE_UNITS = 64 * 1024;
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
          const parsed = parseUtf8Json(
            prefix.bytes,
            operation,
            path,
            "cli-json-input",
          );
          return parsed.ok
            ? ok(parsed.value)
            : err(invalidJson(operation, parsed.error, parsed.cause));
        }
        await pipeline(
          decodedChunks(handle, signal, prefix?.bytes),
          parser.asStream({
            jsonStreaming: false,
            streamValues: false,
            packKeys: false,
            packStrings: false,
          }),
          packJsonStrings(operation, stats.size),
          streamValues.asStream(),
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
        if (cause instanceof AnalysisResourceConstraintError) return err(cause);
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
                remediationAction: JSON_INPUT_RESOURCE_REMEDIATION,
              },
            ),
          );
        throw cause;
      }
    },
    signal,
  );

const packJsonStrings = (operation: string, inputFileBytes: number) =>
  async function* (tokens: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    let kind: "keyValue" | "stringValue" | undefined;
    let length = 0;
    let value = "";
    let parts: string[] = [];
    let partLength = 0;
    for await (const token of tokens) {
      if (typeof token !== "object" || token === null || !("name" in token))
        throw new Error("Unexpected JSON parser token");
      switch (token.name) {
        case "startKey":
        case "startString":
          kind = token.name === "startKey" ? "keyValue" : "stringValue";
          break;
        case "stringChunk":
          if (
            kind === undefined ||
            !("value" in token) ||
            typeof token.value !== "string"
          )
            throw new Error("Unexpected JSON string fragment");
          length += token.value.length;
          if (length > constants.MAX_STRING_LENGTH)
            throw new RangeError("Invalid string length");
          parts.push(token.value);
          partLength += token.value.length;
          if (partLength >= PACKED_STRING_PART_CODE_UNITS) {
            // The tokenizer emits short fragments. Coalesce them before retaining
            // a string so millions of substring/rope nodes cannot exhaust the heap
            // before the native string-length constraint can be reported.
            requireStringAssemblyHeadroom(operation, inputFileBytes, length);
            value += parts.join("");
            parts = [];
            partLength = 0;
          }
          break;
        case "endKey":
        case "endString":
          if (kind === undefined) throw new Error("Unexpected JSON string end");
          requireStringAssemblyHeadroom(operation, inputFileBytes, length);
          yield { name: kind, value: value + parts.join("") };
          kind = undefined;
          length = 0;
          value = "";
          parts = [];
          partLength = 0;
          break;
        default:
          yield token;
      }
    }
  };

const requireStringAssemblyHeadroom = (
  operation: string,
  inputFileBytes: number,
  stringCodeUnits: number,
): void => {
  if (stringCodeUnits < PACKED_STRING_PART_CODE_UNITS) return;
  const heap = getHeapStatistics();
  // Concatenation or key interning may flatten the retained rope. Reserve its
  // UTF-16 representation and the next coalesced part before that allocation.
  const requiredBytes = 2 * (stringCodeUnits + PACKED_STRING_PART_CODE_UNITS);
  if (requiredBytes > heap.total_available_size)
    throw new AnalysisResourceConstraintError(
      operation,
      "memory",
      "Insufficient heap headroom to assemble a complete JSON string",
      {
        input_file_bytes: inputFileBytes,
        string_code_units: stringCodeUnits,
        string_assembly_headroom_bytes: requiredBytes,
        available_heap_bytes: heap.total_available_size,
        heap_size_limit_bytes: heap.heap_size_limit,
      },
      {
        remediationAction: JSON_INPUT_RESOURCE_REMEDIATION,
      },
    );
};

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
