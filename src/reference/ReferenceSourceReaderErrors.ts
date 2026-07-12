import {
  type ReferenceSourceEntry,
  type ReferenceSourceFailureCode,
  type ReferenceSourceReaderError,
} from "./ReferenceSourceReaderTypes.js";

export const failure = (
  code: ReferenceSourceReaderError["code"],
  message: string,
): ReferenceSourceReaderError => ({
  tag: "reference-source-reader",
  code,
  message,
});

export const cancelled = (): ReferenceSourceReaderError =>
  failure("cancelled", "Reference source traversal cancelled");

export const safeSize = (size: bigint): number | undefined => {
  const value = Number(size);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

export const entryFailure = (
  ...[path, kind, code, message, size]: readonly [
    string,
    Extract<ReferenceSourceEntry, { status: "failed" }>["kind"],
    ReferenceSourceFailureCode,
    string,
    size?: number,
  ]
): ReferenceSourceEntry => ({
  status: "failed",
  kind,
  path,
  code,
  message,
  ...(size === undefined ? {} : { size }),
});
