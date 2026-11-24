export const write16 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt16BE(value, offset);
};

export const write32 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
};

export const write64 = (
  bytes: Buffer,
  offset: number,
  value: number | bigint,
  little: boolean,
): void => {
  if (little) bytes.writeBigUInt64LE(BigInt(value), offset);
  else bytes.writeBigUInt64BE(BigInt(value), offset);
};

export const writeWord = (
  bytes: Buffer,
  offset: number,
  value: number | bigint,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (bits === 64) write64(bytes, offset, value, little);
  else write32(bytes, offset, Number(value), little);
};
