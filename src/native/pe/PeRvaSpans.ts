/** PE32+ retains 32-bit RVAs even where virtual addresses are 64-bit. */
export const PE_RVA_END = 0x100000000;

/** Whether a nonempty span fits within the 32-bit RVA space. */
export const fitsPeRvaSpan = (rva: number, size: number): boolean =>
  Number.isSafeInteger(rva) &&
  rva >= 0 &&
  Number.isSafeInteger(size) &&
  size > 0 &&
  rva <= PE_RVA_END - size;

/** Append a consumed file span, merging only with a contiguous predecessor. */
export const appendPeConsumedSpan = (
  spans: { offset: number; bytes: number }[],
  offset: number,
  bytes: number,
): void => {
  const last = spans.at(-1);
  if (last !== undefined && last.offset + last.bytes === offset)
    last.bytes += bytes;
  else spans.push({ offset, bytes });
};
