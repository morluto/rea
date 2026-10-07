import { z } from "zod";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError, AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { safeParseJson } from "../../domain/safeJson.js";

/** The selected artifact and input field owning a reader failure. */
export interface WebArtifactReadContext {
  readonly operation: "trace_web_module_imports" | "trace_web_source_location";
  readonly field: readonly (string | number)[];
  readonly targetPath: string;
}

/** A malformed producer document, distinct from host I/O failures. */
export class WebArtifactFormatFailure extends Error {}

/** Decode exact UTF-8 content, preserving a BOM for digest verification. */
export const decodeWebArtifact = (bytes: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new WebArtifactFormatFailure("Selected artifact is not valid UTF-8.", { cause });
  }
};

/** Read one stable JSON artifact with a documented byte budget. */
export const readWebArtifactJson = async (path: string, maximumBytes: number, signal?: AbortSignal) => {
  const data = await readStableArtifact(path, maximumBytes, signal);
  const value = safeParseJson(decodeWebArtifact(data.bytes));
  if (!value.ok) throw new WebArtifactFormatFailure(value.error);
  return { ...data, value: value.value };
};

/** Preserve artifact format, integrity, OS I/O, and cancellation reasons. */
export const webArtifactReadError = (
  cause: unknown,
  context: WebArtifactReadContext,
  signal?: AbortSignal,
): AnalysisError => {
  if (signal?.aborted === true) return new AnalysisCancelledError(context.operation);
  if (cause instanceof ArtifactReaderFailure)
    return new ArtifactOperationError(context.operation, cause.reason, cause.details, cause.message);
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string" &&
      "syscall" in cause && typeof cause.syscall === "string")
    return new ArtifactOperationError(context.operation, "io", undefined,
      `${context.field.join(".")}: ${cause.code}: ${cause.message}`);
  if (cause instanceof WebArtifactFormatFailure || cause instanceof z.ZodError)
    return new AnalysisInputError(context.operation, { cause }, [{
      path: context.field,
      reason: "invalid_format",
      message: `${context.targetPath}: ${cause.message}`,
    }]);
  return new ProviderAdapterError("captured-web-artifacts", context.operation, {
    cause,
    diagnostics: {
      target_path: context.targetPath,
      field: context.field.join("."),
      error_message: cause instanceof Error ? cause.message : String(cause),
    },
  });
};
