import { OBSERVED_NATIVE_ADDRESS_PATTERN } from "./nativeAddress.js";

/** Parsed observed coordinate retaining optional address-space identity. */
export interface NativeAddressCoordinate {
  readonly space: string | null;
  readonly offset: bigint;
}

/** Parse observed native offsets without discarding their address space. */
export const addressCoordinate = (
  value: string,
): NativeAddressCoordinate | null => {
  // Equivalent to nativeAddressObservationSchema.pipe(nativeAddressCoordinateInputSchema)
  // because OBSERVED_NATIVE_ADDRESS_PATTERN already enforces uppercase %XX escapes
  // and lowercase 0x hex, avoiding per-call Zod pipe allocations in sorts and lookups.
  if (typeof value !== "string" || !OBSERVED_NATIVE_ADDRESS_PATTERN.test(value))
    return null;
  const separator = value.lastIndexOf(":") + 1;
  return {
    space: separator === 0 ? null : value.slice(0, separator - 1),
    offset: BigInt(value.slice(separator)),
  };
};

/** Return a bounded byte distance between canonical addresses in one space. */
export const addressDistance = (start: string, end: string): number | null => {
  const left = addressCoordinate(start);
  const right = addressCoordinate(end);
  if (left === null || right === null || left.space !== right.space)
    return null;
  const distance = right.offset - left.offset;
  if (distance < 0n || distance > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(distance);
};
