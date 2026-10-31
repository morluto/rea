import { closeSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { jsonValueByteLength } from "../../src/domain/jsonValueByteLength.js";
import { inspectSummary } from "./summary.ts";
import {
  boundedJson,
  diagnostic,
  IncompleteReadFailure,
  InspectionFailure,
  OUTPUT_BYTES,
} from "./limits.ts";
import type { BoundedReadable } from "./limits.ts";
import {
  AdmissionEvidence,
  fileState,
  observeFileState,
} from "./file-state.ts";
import {
  omittedRequest,
  parseRequest,
  validateRequest,
  type RequestProvenance,
} from "./request.ts";

function readRange(fd: number, offset: bigint, size: bigint): Buffer {
  const buffer = Buffer.alloc(Number(size));
  let received = 0;
  while (received < buffer.length) {
    let bytes: number;
    try {
      bytes = readSync(
        fd,
        buffer,
        received,
        buffer.length - received,
        Number(offset) + received,
      );
    } catch (cause) {
      throw new IncompleteReadFailure(
        "io",
        cause instanceof Error ? cause.message : String(cause),
        buffer.subarray(0, received),
      );
    }
    if (bytes === 0)
      throw new IncompleteReadFailure(
        "changed",
        "File became shorter during inspection",
        buffer.subarray(0, received),
      );
    received += bytes;
  }
  return buffer;
}

async function main(): Promise<void> {
  let descriptor: number | undefined;
  let source: JsonValue = { input: null };
  let originalRequest: RequestProvenance = {
    arguments: process.argv.slice(2),
    positionals: null,
  };
  let request: JsonValue = originalRequest;
  let finalState: ReturnType<typeof observeFileState> | null = null;
  let report: Record<string, JsonValue> = {};
  let readRanges: BoundedReadable["reads"] = [];
  let error: ReturnType<typeof diagnostic> | null = null;
  let fileError: ReturnType<typeof diagnostic> | null = null;
  let cleanupError: ReturnType<typeof diagnostic> | null = null;
  try {
    const parsed = parseRequest(originalRequest.arguments);
    originalRequest = parsed.request;
    request = parsed.request;
    source = { input: parsed.positionals[0] ?? null };
    const requestLimit = new InspectionFailure(
      "limit",
      "Request provenance exceeds the JSON output budget",
    );
    const minimumReceipt = {
      ok: false,
      request,
      source,
      file_state: null,
      read_ranges: [],
      error: diagnostic(requestLimit),
      file_error: null,
      cleanup_error: null,
    };
    if (jsonValueByteLength(minimumReceipt, OUTPUT_BYTES) > OUTPUT_BYTES) {
      request = omittedRequest(originalRequest);
      source = { input: null, input_omitted: "json_limit" };
      throw requestLimit;
    }
    const selection = validateRequest(parsed);
    if (!selection.ok) throw selection.error;
    const { input, schemaId } = selection.value;
    const path = resolve(input);
    const admission = new AdmissionEvidence();
    source = { input, path, admission: admission.observations };
    const named = admission.readPath(path);
    if (!named.isFile())
      throw new InspectionFailure(
        "input",
        "Select a regular file, not a directory, device or symlink",
      );
    descriptor = admission.open(path);
    const fd = descriptor;
    const initial = admission.readDescriptor(fd, named);
    if (admission.observations.matches_path !== true)
      throw new InspectionFailure("changed", "File changed during admission");
    source = {
      input,
      path,
      ...fileState(initial),
      hash_scope: "individual_read_ranges_not_whole_file",
    };
    const result = await inspectSummary(
      {
        size: async () => initial.size,
        read: async (offset, size) => readRange(fd, offset, size),
      },
      schemaId,
    );
    if (!result.ok) {
      const { read_ranges, ...problem } = result.error;
      readRanges = read_ranges;
      error = problem;
      process.exitCode = 1;
    } else {
      const { read_ranges, ...summary } = result.value;
      readRanges = read_ranges;
      report = summary;
    }
    finalState = observeFileState(fd, path, initial);
    if (
      finalState.descriptor.matches_initial !== true ||
      finalState.path.matches_initial !== true
    )
      throw new InspectionFailure(
        finalState.descriptor.matches_initial === false ||
          finalState.path.matches_initial === false
          ? "changed"
          : "io",
        "File identity or metadata could not be confirmed unchanged after inspection",
      );
  } catch (cause) {
    const problem = diagnostic(cause, "io_or_usage");
    if (error === null) error = problem;
    else fileError = problem;
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cause) {
        cleanupError = diagnostic(cause, "io");
        process.exitCode = 1;
      }
    }
  }
  const receipt = {
    request,
    source,
    file_state: finalState,
    read_ranges: readRanges,
    error,
    file_error: fileError,
    cleanup_error: cleanupError,
  };
  let output: string;
  try {
    output = boundedJson({
      ok: error === null && cleanupError === null,
      ...receipt,
      ...report,
    });
  } catch (cause) {
    const failure = {
      ok: false,
      ...receipt,
      output_error: diagnostic(cause),
      report_omitted: "json_limit",
    };
    output = boundedJson(
      jsonValueByteLength(failure, OUTPUT_BYTES) > OUTPUT_BYTES
        ? { ...failure, request: omittedRequest(originalRequest) }
        : failure,
    );
    process.exitCode = 1;
  }
  process.stdout.write(`${output}\n`);
}

await main();
