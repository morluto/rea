/** Test-only systemd journal builder shared by reader and boundary tests. */
export const HEADER_BYTES = 272;
const JOURNAL_HEADER_MIN_BYTES = 208;

export interface ObjectSpec {
  readonly type: number;
  readonly flags?: number;
  readonly size: number;
}

/** A minimal, structurally valid journal: fixed header plus aligned objects. */
export const journalBytes = (
  options: {
    readonly objects?: readonly ObjectSpec[];
    readonly headerSize?: number;
    readonly nObjects?: number;
    readonly state?: number;
    readonly incompatibleFlags?: number;
    readonly compatibleFlags?: number;
    readonly tailBytes?: number;
    readonly tailObjectOffset?: number;
  } = {},
): Buffer => {
  const objects = options.objects ?? [];
  /** Each object starts at the previous extent aligned up to eight bytes. */
  const bodySize = objects.reduce(
    (total, object) => total + Math.ceil(Math.min(object.size, 64) / 8) * 8,
    0,
  );
  /** The object area begins after the declared header, which may differ from 272. */
  const objectStart = Math.max(
    JOURNAL_HEADER_MIN_BYTES,
    options.headerSize ?? HEADER_BYTES,
  );
  const file = Buffer.alloc(objectStart + bodySize + (options.tailBytes ?? 0));
  file.write("LPKSHHRH", 0, "latin1");
  file.writeUInt32LE(options.compatibleFlags ?? 0, 8);
  file.writeUInt32LE(options.incompatibleFlags ?? 0, 12);
  file.writeUInt8(options.state ?? 1, 16);
  for (let index = 0; index < 4; index += 1)
    file.fill(0x10 + index, 24 + index * 16, 24 + (index + 1) * 16);
  file.writeBigUInt64LE(BigInt(options.headerSize ?? HEADER_BYTES), 88);
  file.writeBigUInt64LE(BigInt(file.length - objectStart), 96);
  file.writeBigUInt64LE(BigInt(options.nObjects ?? objects.length), 144);
  const tailObjectOffset = options.tailObjectOffset;
  if (tailObjectOffset !== undefined)
    file.writeBigUInt64LE(BigInt(tailObjectOffset), 136);
  /** An oversized object is written only as far as the file's stub for it. */
  let offset = objectStart;
  for (const object of objects) {
    file.writeUInt8(object.type, offset);
    file.writeUInt8(object.flags ?? 0, offset + 1);
    file.writeBigUInt64LE(BigInt(object.size), offset + 8);
    offset += Math.ceil(Math.min(object.size, 64) / 8) * 8;
  }
  return file;
};
