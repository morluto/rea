import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { cancelledBy, carriedReason } from "../domain/analysisErrorCore.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import { err, ok, type Result } from "../domain/result.js";
import { isRecord } from "../kernel/isRecord.js";

export type UnknownRecord = Readonly<Record<string, unknown>>;

export const recordValue = (value: unknown): UnknownRecord | undefined =>
  isRecord(value) ? value : undefined;

/** Preserve an omitted producer inventory as unknown rather than empty. */
export const admitRecords = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

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

/** An omitted resource size is unknown; a supplied invalid size is malformed. */
export const resourceContentSize = (
  value: unknown,
): Result<number | null, { readonly _tag: "InvalidCdpResourceSize" }> => {
  if (value === undefined) return ok(null);
  const size = numberValue(value);
  return size !== undefined && size >= 0
    ? ok(size)
    : err({ _tag: "InvalidCdpResourceSize" });
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
  let remaining = durationMs;
  while (remaining > 0) {
    if (signal?.aborted === true) throw cancelledBy(operation, signal);
    const delay = Math.min(remaining, MAX_NODE_TIMER_DELAY_MS);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(cancelledBy(operation, carriedReason(signal?.reason)));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
    remaining -= delay;
  }
};
