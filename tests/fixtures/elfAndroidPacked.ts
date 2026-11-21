/** Independent wire writer for deliberately selected APS2 group fields. */
export const aps2Table = (
  values: readonly (number | bigint)[],
  padding = 0,
): Buffer => {
  const bytes = [...Buffer.from("APS2")];
  for (const value of values) {
    let remaining = BigInt(value);
    for (;;) {
      const byte = Number(remaining & 127n);
      remaining >>= 7n;
      const done =
        (remaining === 0n && (byte & 64) === 0) ||
        (remaining === -1n && (byte & 64) !== 0);
      bytes.push(byte | (done ? 0 : 128));
      if (done) break;
    }
  }
  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(padding)]);
};

/** Write selected ordinary records as one ungrouped APS2 run. */
export const aps2Relocations = (
  records: readonly {
    readonly offset: bigint;
    readonly info: bigint;
    readonly addend?: bigint;
  }[],
  encoding: "rel" | "rela",
): Buffer => {
  const fields = [BigInt(records.length), 0n];
  if (records.length > 0)
    fields.push(BigInt(records.length), encoding === "rela" ? 8n : 0n);
  let previousOffset = 0n,
    previousAddend = 0n;
  for (const { offset, info, addend = 0n } of records) {
    fields.push(offset - previousOffset, BigInt.asIntN(64, info));
    if (encoding === "rela") fields.push(addend - previousAddend);
    previousOffset = offset;
    previousAddend = addend;
  }
  return aps2Table(fields);
};
