/**
 * Builds `perf.data` files for tests from the documented on-disk layout rather
 * than from the parser's own helpers: a fixture that reused the reader would
 * keep passing if that reader were wrong.
 */
export const PERF_ATTR_BYTES = 128;
/** `attr_size` is `sizeof(perf_event_attr) + sizeof(perf_file_section)`. */
export const PERF_STRIDE = PERF_ATTR_BYTES + 16;
export const PERF_HEADER_BYTES = 0x68;
export const PERF_HEADER_BYTES_WITHOUT_FEATURES = 0x48;
export const PERF_ATTR_FLAG_FREQ = 0x400;

/**
 * `perf_event_attr` stores `freq` in a C bitfield, which a big-endian host
 * writes from the high end of the 64-bit word: the flag that sits at bit 10
 * in the little-endian layout lands at bit 53 on disk there. `perf` undoes
 * this with `swap_bitfield` on read, so a fixture that wrote the same numeric
 * word in both byte orders would encode the little-endian assumption rather
 * than the file a big-endian recorder produces.
 */
const bigEndianFlags = (flags: bigint): bigint => {
  let swapped = 0n;
  for (let bit = 0n; bit < 64n; bit += 1n)
    if (((flags >> bit) & 1n) === 1n) swapped |= 1n << (63n - bit);
  return swapped;
};

export interface PerfEntry {
  readonly type: number;
  readonly config: number;
  readonly samplePeriod: number;
  readonly sampleType: number;
  readonly readFormat: number;
  readonly freq: boolean;
  readonly ids: readonly number[];
}

export interface PerfRecordingOptions {
  readonly little?: boolean;
  readonly entries?: readonly PerfEntry[];
  readonly headerBytes?: number;
  readonly attrBytes?: number;
}

const u64 = (value: bigint, little: boolean): Buffer => {
  const bytes = Buffer.alloc(8);
  if (little) bytes.writeBigUInt64LE(value);
  else bytes.writeBigUInt64BE(value);
  return bytes;
};

const u32 = (value: number, little: boolean): Buffer => {
  const bytes = Buffer.alloc(4);
  if (little) bytes.writeUInt32LE(value, 0);
  else bytes.writeUInt32BE(value, 0);
  return bytes;
};

/** Builds one attribute entry and points its ids section at `idsAt`. */
const entry = (
  fields: PerfEntry,
  little: boolean,
  attrBytes: number,
  idsAt: number,
): Buffer => {
  const bytes = Buffer.alloc(attrBytes + 16);
  u32(fields.type, little).copy(bytes, 0x00);
  u32(attrBytes, little).copy(bytes, 0x04);
  u64(BigInt(fields.config), little).copy(bytes, 0x08);
  u64(BigInt(fields.samplePeriod), little).copy(bytes, 0x10);
  u64(BigInt(fields.sampleType), little).copy(bytes, 0x18);
  u64(BigInt(fields.readFormat), little).copy(bytes, 0x20);
  const flags = fields.freq ? BigInt(PERF_ATTR_FLAG_FREQ) : 0n;
  u64(little ? flags : bigEndianFlags(flags), little).copy(bytes, 0x28);
  u64(BigInt(idsAt), little).copy(bytes, attrBytes);
  return bytes;
};

export const perfEntry = (overrides: Partial<PerfEntry> = {}): PerfEntry => ({
  type: 0,
  config: 0,
  samplePeriod: 1000,
  sampleType: 0,
  readFormat: 1,
  freq: false,
  ids: [7],
  ...overrides,
});

/** Assembles a file whose id arrays follow the attribute section. */
export const buildPerfRecording = (
  options: PerfRecordingOptions = {},
): Buffer => {
  const little = options.little ?? true;
  const entries = options.entries ?? [perfEntry()];
  const headerBytes = options.headerBytes ?? PERF_HEADER_BYTES;
  const attrBytes = options.attrBytes ?? PERF_ATTR_BYTES;
  const stride = attrBytes + 16;
  const idsStart = headerBytes + entries.length * stride;
  let idsCursor = idsStart;
  const attributes: Buffer[] = [];
  const idBlocks: Buffer[] = [];
  for (const fields of entries) {
    const ids = Buffer.concat(fields.ids.map((id) => u64(BigInt(id), little)));
    const block = entry(fields, little, attrBytes, idsCursor);
    u64(BigInt(ids.length), little).copy(block, attrBytes + 8);
    attributes.push(block);
    idBlocks.push(ids);
    idsCursor += ids.length;
  }
  const attrSection = Buffer.concat(attributes);
  const idSection = Buffer.concat(idBlocks);
  const dataOffset = idsStart + idSection.length;
  // The magic encodes the writer's byte order and reads PERFILE2 in it.
  const magic = little ? "PERFILE2" : "2ELIFREP";
  const header = Buffer.concat([
    Buffer.from(magic, "latin1"),
    u64(BigInt(headerBytes), little),
    u64(BigInt(stride), little),
    u64(BigInt(headerBytes), little),
    u64(BigInt(attrSection.length), little),
    u64(BigInt(dataOffset), little),
    u64(8n, little),
    u64(0n, little),
    u64(0n, little),
  ]);
  return Buffer.concat([
    header,
    Buffer.alloc(headerBytes - header.length),
    attrSection,
    idSection,
    Buffer.alloc(8),
  ]);
};
