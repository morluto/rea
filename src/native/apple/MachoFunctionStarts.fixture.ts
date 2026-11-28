/** Synthetic little-endian Mach-O images for function-start tests. No vendor bytes. */

export const MACHO_TEXT_BASE = 0x100000000n;
export const MACHO_FUNCTION_STARTS_FILE_BYTES = 0x5000;
const LINKEDIT_OFFSET = 0x4000;
const TEXT_VM_SIZE = 0x4000;

const CPU = {
  arm64: { type: 0x0100000c, subtype: 0 },
  x86_64: { type: 0x01000007, subtype: 3 },
} as const;

export type MachoFunctionStartsCpu = keyof typeof CPU;

export interface MachoLinkeditDuplicateCommand {
  readonly offset?: number;
  readonly declaredSize?: number;
  readonly commandSize?: number;
}

export interface MachoFunctionStartBlob {
  readonly deltas?: readonly bigint[];
  readonly blob?: Buffer;
  /** Include the zero terminator. Default true. Ignored when `blob` is set. */
  readonly terminator?: boolean;
  readonly padding?: number;
  /** One nonzero byte after the terminator and padding. */
  readonly trailingByte?: number;
  /** Slice file offset of the payload. Default: start of __LINKEDIT. */
  readonly offset?: number;
  /** Declared datasize. Default: the payload length. */
  readonly declaredSize?: number;
  /** linkedit_data_command cmdsize. Default 16. */
  readonly commandSize?: number;
  readonly duplicate?: boolean | MachoLinkeditDuplicateCommand;
}

export interface MachoDataInCodeBlob {
  readonly entries?: readonly {
    readonly offset: number;
    readonly length: number;
    readonly kind: number;
  }[];
  readonly blob?: Buffer;
  readonly trailing?: number;
  readonly offset?: number;
  readonly declaredSize?: number;
  readonly commandSize?: number;
  readonly duplicate?: boolean | MachoLinkeditDuplicateCommand;
}

export interface MachoFunctionStartsImageOptions {
  readonly cpu?: MachoFunctionStartsCpu;
  readonly starts?: MachoFunctionStartBlob;
  readonly data?: MachoDataInCodeBlob;
  readonly omitText?: boolean;
  readonly omitLinkedit?: boolean;
  /** __TEXT filesize. Default equals its vmsize, so the segment covers its file bytes. */
  readonly textFileSize?: number;
  /** __TEXT segment `flags`, such as SG_HIGHVM (0x1). Default 0. */
  readonly textFlags?: number;
  /** `mach_header.filetype`. Default MH_EXECUTE (2). */
  readonly fileType?: number;
  /** `sectname` of the code section. Default `__text`; "" writes all zeros. */
  readonly textSectionName?: string;
  /** Segments appended after __LINKEDIT, such as one aliasing __TEXT file bytes. */
  readonly extraSegments?: readonly {
    readonly name: string;
    readonly address: bigint;
    readonly memorySize: number;
    readonly fileOffset: number;
    readonly fileSize: number;
    readonly protection: number;
  }[];
  /** Total file bytes. Default `MACHO_FUNCTION_STARTS_FILE_BYTES`. */
  readonly fileBytes?: number;
}

/** ULEB128 used by LC_FUNCTION_STARTS. The high bit continues the integer. */
export const encodeUleb = (value: bigint): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0n);
  return Buffer.from(bytes);
};

/** Absolute VM addresses of `deltas` added to the __TEXT vmaddr. */
export const functionStartAddresses = (
  deltas: readonly bigint[],
  base = MACHO_TEXT_BASE,
): readonly bigint[] => {
  const addresses: bigint[] = [];
  let cursor = base;
  for (const delta of deltas) {
    cursor += delta;
    addresses.push(cursor);
  }
  return addresses;
};

const encodeStarts = (starts: MachoFunctionStartBlob): Buffer => {
  if (starts.blob !== undefined) return starts.blob;
  const parts = (starts.deltas ?? []).map((delta) => encodeUleb(delta));
  if (starts.terminator !== false) parts.push(Buffer.from([0]));
  if ((starts.padding ?? 0) > 0) parts.push(Buffer.alloc(starts.padding ?? 0));
  if (starts.trailingByte !== undefined)
    parts.push(Buffer.from([starts.trailingByte]));
  return Buffer.concat(parts);
};

const encodeData = (data: MachoDataInCodeBlob): Buffer => {
  if (data.blob !== undefined) return data.blob;
  const entries = data.entries ?? [];
  const trailing = data.trailing ?? 0;
  const bytes = Buffer.alloc(entries.length * 8 + trailing);
  for (const [index, entry] of entries.entries()) {
    const at = index * 8;
    bytes.writeUInt32LE(entry.offset, at);
    bytes.writeUInt16LE(entry.length, at + 4);
    bytes.writeUInt16LE(entry.kind, at + 6);
  }
  return bytes;
};

const name16 = (text: string): Buffer => {
  const bytes = Buffer.alloc(16);
  bytes.write(text, 0, "utf8");
  return bytes;
};

const segment64 = (
  name: string,
  address: bigint,
  memorySize: number,
  fileOffset: number,
  fileSize: number,
  protection: number,
  sections: readonly Buffer[],
  flags = 0,
): Buffer => {
  const bytes = Buffer.alloc(72 + sections.length * 80);
  bytes.writeUInt32LE(0x19, 0);
  bytes.writeUInt32LE(bytes.length, 4);
  name16(name).copy(bytes, 8);
  bytes.writeBigUInt64LE(address, 24);
  bytes.writeBigUInt64LE(BigInt(memorySize), 32);
  bytes.writeBigUInt64LE(BigInt(fileOffset), 40);
  bytes.writeBigUInt64LE(BigInt(fileSize), 48);
  bytes.writeUInt32LE(protection, 56);
  bytes.writeUInt32LE(protection, 60);
  bytes.writeUInt32LE(sections.length, 64);
  bytes.writeUInt32LE(flags, 68);
  for (const [index, section] of sections.entries())
    section.copy(bytes, 72 + index * 80);
  return bytes;
};

const section64 = (
  section: string,
  segment: string,
  address: bigint,
  size: number,
  offset: number,
  flags: number,
): Buffer => {
  const bytes = Buffer.alloc(80);
  name16(section).copy(bytes, 0);
  name16(segment).copy(bytes, 16);
  bytes.writeBigUInt64LE(address, 32);
  bytes.writeBigUInt64LE(BigInt(size), 40);
  bytes.writeUInt32LE(offset, 48);
  bytes.writeUInt32LE(flags, 64);
  return bytes;
};

const linkeditCommand = (
  command: number,
  dataoff: number,
  datasize: number,
  size: number,
): Buffer => {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(command, 0);
  bytes.writeUInt32LE(size, 4);
  if (size >= 12) bytes.writeUInt32LE(dataoff, 8);
  if (size >= 16) bytes.writeUInt32LE(datasize, 12);
  return bytes;
};

const place = (file: Buffer, offset: number, bytes: Buffer): void => {
  if (offset < 0 || offset + bytes.length > file.length)
    throw new Error(
      `fixture payload at ${offset} does not fit in ${file.length} bytes`,
    );
  bytes.copy(file, offset);
};

const appendDuplicateCommand = (
  file: Buffer,
  commands: Buffer[],
  options: {
    readonly command: number;
    readonly duplicate: boolean | MachoLinkeditDuplicateCommand | undefined;
    readonly defaultOffset: number;
    readonly decoy: Buffer;
  },
): void => {
  if (options.duplicate === undefined || options.duplicate === false) return;
  const spec = options.duplicate === true ? {} : options.duplicate;
  if (spec.offset === undefined)
    place(file, options.defaultOffset, options.decoy);
  commands.push(
    linkeditCommand(
      options.command,
      spec.offset ?? options.defaultOffset,
      spec.declaredSize ?? options.decoy.length,
      spec.commandSize ?? 16,
    ),
  );
};

/**
 * One thin arm64 or x86_64 MH_EXECUTE image.
 *
 * __TEXT covers file 0..textFileSize at `MACHO_TEXT_BASE` and holds `__text`
 * then `__literal`. __LINKEDIT covers file 0x4000..0x5000. Payloads default
 * into __LINKEDIT.
 */
export const machoFunctionStartsImage = (
  options: MachoFunctionStartsImageOptions = {},
): Buffer => {
  const file = Buffer.alloc(
    options.fileBytes ?? MACHO_FUNCTION_STARTS_FILE_BYTES,
  );
  const cpu = CPU[options.cpu ?? "arm64"];
  const textFileSize = options.textFileSize ?? TEXT_VM_SIZE;
  const commands: Buffer[] = [];
  if (options.omitText !== true) {
    commands.push(
      segment64(
        "__TEXT",
        MACHO_TEXT_BASE,
        TEXT_VM_SIZE,
        0,
        textFileSize,
        5,
        [
          section64(
            options.textSectionName ?? "__text",
            "__TEXT",
            MACHO_TEXT_BASE + 0x1000n,
            0x800,
            0x1000,
            0x80000400,
          ),
          section64(
            "__literal",
            "__TEXT",
            MACHO_TEXT_BASE + 0x1800n,
            0x800,
            0x1800,
            0,
          ),
        ],
        options.textFlags ?? 0,
      ),
    );
  }
  if (options.omitLinkedit !== true) {
    commands.push(
      segment64(
        "__LINKEDIT",
        MACHO_TEXT_BASE + BigInt(LINKEDIT_OFFSET),
        0x1000,
        LINKEDIT_OFFSET,
        0x1000,
        1,
        [],
      ),
    );
  }
  for (const segment of options.extraSegments ?? [])
    commands.push(
      segment64(
        segment.name,
        segment.address,
        segment.memorySize,
        segment.fileOffset,
        segment.fileSize,
        segment.protection,
        [],
      ),
    );
  if (options.starts !== undefined) {
    const payload = encodeStarts(options.starts);
    const offset = options.starts.offset ?? LINKEDIT_OFFSET;
    place(file, offset, payload);
    commands.push(
      linkeditCommand(
        0x26,
        offset,
        options.starts.declaredSize ?? payload.length,
        options.starts.commandSize ?? 16,
      ),
    );
    appendDuplicateCommand(file, commands, {
      command: 0x26,
      duplicate: options.starts.duplicate,
      defaultOffset: 0x4400,
      decoy: Buffer.concat([encodeUleb(1n), Buffer.from([0])]),
    });
  }
  if (options.data !== undefined) {
    const payload = encodeData(options.data);
    const offset = options.data.offset ?? 0x4200;
    place(file, offset, payload);
    commands.push(
      linkeditCommand(
        0x29,
        offset,
        options.data.declaredSize ?? payload.length,
        options.data.commandSize ?? 16,
      ),
    );
    appendDuplicateCommand(file, commands, {
      command: 0x29,
      duplicate: options.data.duplicate,
      defaultOffset: 0x4600,
      decoy: encodeData({
        entries: [{ offset: 0x10, length: 1, kind: 1 }],
      }),
    });
  }
  const commandBytes = Buffer.concat(commands);
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeUInt32LE(cpu.type, 4);
  file.writeUInt32LE(cpu.subtype, 8);
  file.writeUInt32LE(options.fileType ?? 2, 12);
  file.writeUInt32LE(commands.length, 16);
  file.writeUInt32LE(commandBytes.length, 20);
  commandBytes.copy(file, 32);
  return file;
};

/** FAT32 file whose arm64 and x86_64 slices are the two thin images. */
export const machoFunctionStartsUniversal = (
  arm64: Buffer,
  x86_64: Buffer,
): Buffer => {
  const align = 0x1000;
  const armOffset = align;
  const x64Offset = align + Math.ceil(arm64.length / align) * align;
  const file = Buffer.alloc(x64Offset + x86_64.length);
  file.writeUInt32BE(0xcafebabe, 0);
  file.writeUInt32BE(2, 4);
  const arch = (
    at: number,
    cpu: number,
    offset: number,
    size: number,
  ): void => {
    file.writeUInt32BE(cpu, at);
    file.writeUInt32BE(
      cpu === CPU.x86_64.type ? CPU.x86_64.subtype : 0,
      at + 4,
    );
    file.writeUInt32BE(offset, at + 8);
    file.writeUInt32BE(size, at + 12);
    file.writeUInt32BE(12, at + 16);
  };
  arch(8, CPU.arm64.type, armOffset, arm64.length);
  arch(28, CPU.x86_64.type, x64Offset, x86_64.length);
  arm64.copy(file, armOffset);
  x86_64.copy(file, x64Offset);
  return file;
};

/** Three arm64 starts inside `__text`, and three in-section data entries. */
export const ARM64_DELTAS = [0x1000n, 0x100n, 0x100n] as const;
export const X64_DELTAS = [0x1000n, 0x200n] as const;

export const arm64FunctionStartsImage = (): Buffer =>
  machoFunctionStartsImage({
    cpu: "arm64",
    starts: { deltas: ARM64_DELTAS, padding: 4 },
    data: {
      entries: [
        { offset: 0x1080, length: 8, kind: 1 },
        { offset: 0x1120, length: 4, kind: 2 },
        { offset: 0x1210, length: 4, kind: 0x42 },
      ],
    },
  });

export const x64FunctionStartsImage = (): Buffer =>
  machoFunctionStartsImage({
    cpu: "x86_64",
    starts: { deltas: X64_DELTAS },
    data: {
      entries: [
        { offset: 0x1080, length: 2, kind: 3 },
        { offset: 0x1220, length: 4, kind: 5 },
      ],
    },
  });

/** __TEXT vmaddr of the 32-bit ARM image. */
export const MACHO_ARM32_TEXT_BASE = 0x1000;

const segment32 = (
  name: string,
  address: number,
  memorySize: number,
  fileOffset: number,
  fileSize: number,
  protection: number,
): Buffer => {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0x1, 0);
  bytes.writeUInt32LE(56, 4);
  name16(name).copy(bytes, 8);
  bytes.writeUInt32LE(address, 24);
  bytes.writeUInt32LE(memorySize, 28);
  bytes.writeUInt32LE(fileOffset, 32);
  bytes.writeUInt32LE(fileSize, 36);
  bytes.writeUInt32LE(protection, 40);
  bytes.writeUInt32LE(protection, 44);
  return bytes;
};

/**
 * Thin armv7 executable whose LC_FUNCTION_STARTS holds `deltas`. ld64 sets
 * bit 0 of a Thumb start before taking the next delta, so callers pass the
 * deltas between those tagged values.
 */
export const machoArm32FunctionStartsImage = (
  deltas: readonly bigint[],
): Buffer => {
  const file = Buffer.alloc(MACHO_FUNCTION_STARTS_FILE_BYTES);
  const payload = encodeStarts({ deltas });
  place(file, LINKEDIT_OFFSET, payload);
  const commands = [
    segment32(
      "__TEXT",
      MACHO_ARM32_TEXT_BASE,
      TEXT_VM_SIZE,
      0,
      TEXT_VM_SIZE,
      5,
    ),
    segment32(
      "__LINKEDIT",
      MACHO_ARM32_TEXT_BASE + LINKEDIT_OFFSET,
      0x1000,
      LINKEDIT_OFFSET,
      0x1000,
      1,
    ),
    linkeditCommand(0x26, LINKEDIT_OFFSET, payload.length, 16),
  ];
  const commandBytes = Buffer.concat(commands);
  file.writeUInt32LE(0xfeedface, 0);
  file.writeUInt32LE(12, 4);
  file.writeUInt32LE(9, 8);
  file.writeUInt32LE(2, 12);
  file.writeUInt32LE(commands.length, 16);
  file.writeUInt32LE(commandBytes.length, 20);
  commandBytes.copy(file, 28);
  return file;
};
