/** Relocate fixture tables and encode their counts/index through SHT_NULL section zero. */
export const withElfExtendedNumbering = (
  original: Buffer,
  kind: "sections" | "names" | "programs",
): Buffer => {
  const wide = original[4] === 2;
  const little = original[5] === 1;
  const read16 = (at: number): number =>
    little ? original.readUInt16LE(at) : original.readUInt16BE(at);
  const readWord = (at: number): number =>
    wide
      ? Number(
          little ? original.readBigUInt64LE(at) : original.readBigUInt64BE(at),
        )
      : little
        ? original.readUInt32LE(at)
        : original.readUInt32BE(at);
  const phoff = readWord(wide ? 32 : 28);
  const shoff = readWord(wide ? 40 : 32);
  const phwidth = read16(wide ? 54 : 42);
  const shwidth = read16(wide ? 58 : 46);
  const phcount = read16(wide ? 56 : 44);
  const shcount = read16(wide ? 60 : 48);
  const namesIndex = read16(wide ? 62 : 50);
  if (shcount === 0) throw new Error("Fixture requires a section-zero header");

  const tableOffset = Math.ceil(original.length / 8) * 8;
  const count =
    kind === "programs" ? 0xffff : kind === "names" ? 0xff01 : 0xff00;
  const bytes = Buffer.alloc(
    tableOffset + count * (kind === "programs" ? phwidth : shwidth),
  );
  original.copy(bytes);
  const write16 = (at: number, value: number): void => {
    if (little) bytes.writeUInt16LE(value, at);
    else bytes.writeUInt16BE(value, at);
  };
  const write32 = (at: number, value: number): void => {
    if (little) bytes.writeUInt32LE(value, at);
    else bytes.writeUInt32BE(value, at);
  };
  const writeWord = (at: number, value: number): void => {
    if (!wide) write32(at, value);
    else if (little) bytes.writeBigUInt64LE(BigInt(value), at);
    else bytes.writeBigUInt64BE(BigInt(value), at);
  };
  if (kind === "programs") {
    original.copy(bytes, tableOffset, phoff, phoff + phwidth * phcount);
    writeWord(wide ? 32 : 28, tableOffset);
    write16(wide ? 56 : 44, 0xffff);
    write32(shoff + (wide ? 44 : 28), count);
  } else {
    original.copy(bytes, tableOffset, shoff, shoff + shwidth * shcount);
    writeWord(wide ? 40 : 32, tableOffset);
    write16(wide ? 60 : 48, 0);
    writeWord(tableOffset + (wide ? 32 : 20), count);
    if (kind === "names") {
      original.copy(
        bytes,
        tableOffset + 0xff00 * shwidth,
        shoff + namesIndex * shwidth,
        shoff + (namesIndex + 1) * shwidth,
      );
      write16(wide ? 62 : 50, 0xffff);
      write32(tableOffset + (wide ? 40 : 24), 0xff00);
    }
  }
  return bytes;
};
