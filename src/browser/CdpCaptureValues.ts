import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";

export type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const recordValue = (value: unknown): UnknownRecord | undefined =>
  isRecord(value) ? value : undefined;

export const recordsValue = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record === undefined ? [] : [record];
      })
    : [];

export const cdpStringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Preserve partial script declarations; omitted or invalid fields remain unknown. */
export const scriptMetadataValues = (
  value: UnknownRecord | undefined,
): {
  readonly hash: string | null;
  readonly length: number | null;
  readonly isModule: boolean | null;
} => {
  const length = numberValue(value?.length);
  return {
    hash: cdpStringValue(value?.hash) ?? null,
    length:
      length !== undefined && Number.isSafeInteger(length) && length >= 0
        ? length
        : null,
    isModule: typeof value?.isModule === "boolean" ? value.isModule : null,
  };
};

export const requiredRecord = (value: unknown): UnknownRecord => {
  const record = recordValue(value);
  if (record === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return record;
};

/** Require producer source text; an absent source is distinct from an empty script. */
export const requiredScriptSource = (
  value: unknown,
  operation: BrowserObservationOperation,
): string => {
  const source = cdpStringValue(recordValue(value)?.scriptSource);
  if (source === undefined)
    throw new BrowserObservationError(operation, "protocol_error", {
      detail:
        "Debugger.getScriptSource returned malformed source text: scriptSource must be a string.",
    });
  return source;
};

export const isHttpUrl = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (cause: unknown) {
    // Non-URL input is not an HTTP URL.
    void cause;
    return false;
  }
};

export const allowedSanitizedUrl = (
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): ReturnType<typeof sanitizeBrowserUrl> | undefined => {
  const text = cdpStringValue(value);
  if (text === undefined) return undefined;
  const sanitized = sanitizeBrowserUrl(text);
  return sanitized.origin !== null && allowedOrigins.has(sanitized.origin)
    ? sanitized
    : undefined;
};

export const sourceResult = (
  source: string,
): { included: true; artifact: ReturnType<typeof createWebTextArtifact> } => ({
  included: true,
  artifact: createWebTextArtifact(source, "text/javascript"),
});

export const sourceExcluded = (
  reason: string,
): { included: false; reason: string } => ({ included: false, reason });

export const delayWithCancellation = async (
  durationMs: number,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<void> => {
  const maximumTimerDelay = 2_147_483_647;
  let remaining = durationMs;
  while (remaining > 0) {
    if (signal?.aborted === true) throw new AnalysisCancelledError(operation);
    const delay = Math.min(remaining, maximumTimerDelay);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new AnalysisCancelledError(operation));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
    remaining -= delay;
  }
};
