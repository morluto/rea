import {
  AnalysisCancelledError,
  BrowserObservationError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
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

export const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const requiredRecord = (value: unknown): UnknownRecord => {
  const record = recordValue(value);
  if (record === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return record;
};

export const boundedText = (value: unknown, maximum = 1_024): string | null => {
  const text = stringValue(value);
  return text === undefined ? null : text.slice(0, maximum);
};

export const isHttpUrl = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export const allowedSanitizedUrl = (
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): ReturnType<typeof sanitizeBrowserUrl> | undefined => {
  const text = stringValue(value);
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
  if (durationMs === 0) return;
  if (signal?.aborted === true) throw new AnalysisCancelledError(operation);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new AnalysisCancelledError(operation));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
};
