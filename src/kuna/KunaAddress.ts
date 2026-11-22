const isLowerHexCode = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 97 && code <= 102);

/** Whether `value` is a canonical lowercase u64 hex address (`0x0` or `0x[1-9a-f][0-9a-f]{0,15}`). */
export const isCanonicalKunaHexAddress = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const { length } = value;
  if (length < 3 || length > 18) return false;
  if (value.charCodeAt(0) !== 48 || value.charCodeAt(1) !== 120) return false;
  const first = value.charCodeAt(2);
  if (length === 3) return isLowerHexCode(first);
  if (first === 48 || !isLowerHexCode(first)) return false;
  for (let i = 3; i < length; i += 1) {
    if (!isLowerHexCode(value.charCodeAt(i))) return false;
  }
  return true;
};

/** Normalize a u64 selector without allocating a BigInt for unbounded digits. */
export const normalizeKunaAddress = (value: unknown): string | undefined => {
  if (isCanonicalKunaHexAddress(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /^0x0*([0-9a-f]{1,16})$/iu.exec(value);
  return match?.[1] === undefined
    ? undefined
    : `0x${BigInt(`0x${match[1]}`).toString(16)}`;
};

/** Sort canonical hexadecimal addresses numerically without BigInt allocations. */
export const compareKunaAddresses = (left: string, right: string): number =>
  left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
