import type { JsonValue } from "../domain/jsonValue.js";
import type { NativeLoadImageCheck } from "../domain/native/nativeLoadImage.js";

/** Record one attestation's checks, preserving compared values and source locations. */
export const createLoadImageChecks = () => {
  const checks: NativeLoadImageCheck[] = [];
  const check = (
    name: string,
    expected: JsonValue,
    observed: JsonValue,
    fileOffset: number | null = null,
    location: string | null = null,
  ): void => {
    checks.push({
      name,
      matched: JSON.stringify(expected) === JSON.stringify(observed),
      expected,
      observed,
      file_offset: fileOffset,
      address: location,
    });
  };
  return { checks, check };
};
