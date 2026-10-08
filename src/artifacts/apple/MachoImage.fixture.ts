/** Little-endian Mach-O images and FAT containers built field by field for tests. */

export const LC = {
  LOAD_DYLIB: 0xc,
  ID_DYLIB: 0xd,
  LOAD_WEAK_DYLIB: 0x80000018,
  REEXPORT_DYLIB: 0x8000001f,
  LAZY_LOAD_DYLIB: 0x20,
  LOAD_UPWARD_DYLIB: 0x80000023,
  RPATH: 0x8000001c,
  DYLD_ENVIRONMENT: 0x27,
  CODE_SIGNATURE: 0x1d,
  BUILD_VERSION: 0x32,
} as const;

export const CPU = {
  arm64: { type: 0x0100000c, subtype: 0 },
  arm64e: { type: 0x0100000c, subtype: 0x80000002 },
  x86_64: { type: 0x01000007, subtype: 3 },
} as const;

export const FILE_TYPE = { execute: 2, dylib: 6, bundle: 8 } as const;

const encoder = new TextEncoder();

/** One load command with a NUL-terminated string at `nameOffset`, padded to 8 bytes. */
const commandWithString = (
  command: number,
  fields: readonly number[],
  text: string,
): Uint8Array => {
  const nameOffset = 8 + fields.length * 4 + 4;
  const name = encoder.encode(text);
  const size = Math.ceil((nameOffset + name.length + 1) / 8) * 8;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, command, true);
  view.setUint32(4, size, true);
  view.setUint32(8, nameOffset, true);
  fields.forEach((value, index) => view.setUint32(12 + index * 4, value, true));
  bytes.set(name, nameOffset);
  return bytes;
};

/** Classic `dylib_command`: timestamp, current and compatibility versions. */
export const dylibCommand = (
  command: number,
  name: string,
  versions: { readonly current?: number; readonly compatibility?: number } = {},
): Uint8Array =>
  commandWithString(
    command,
    [2, versions.current ?? 0x10000, versions.compatibility ?? 0x10000],
    name,
  );

/** `dylib_use_command`: marker, versions and `DYLIB_USE_*` flags. */
export const dylibUseCommand = (
  command: number,
  name: string,
  flags: number,
): Uint8Array =>
  commandWithString(command, [0x1a741800, 0x10000, 0x10000, flags], name);

export const rpathCommand = (path: string): Uint8Array =>
  commandWithString(LC.RPATH, [], path);

export const dyldEnvironmentCommand = (value: string): Uint8Array =>
  commandWithString(LC.DYLD_ENVIRONMENT, [], value);

export const codeSignatureCommand = (): Uint8Array => {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, LC.CODE_SIGNATURE, true);
  view.setUint32(4, 16, true);
  return bytes;
};

/** `build_version_command` carrying the producer's raw platform number. */
export const buildVersionCommand = (platform: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, LC.BUILD_VERSION, true);
  view.setUint32(4, bytes.length, true);
  view.setUint32(8, platform, true);
  return bytes;
};

/** A 64-bit (or 32-bit) little-endian Mach-O image made of the given commands. */
export const machoImage = (options: {
  readonly cpu?: { readonly type: number; readonly subtype: number };
  readonly fileType?: number;
  readonly commands?: readonly Uint8Array[];
  readonly wide?: boolean;
}): Uint8Array => {
  const wide = options.wide ?? true;
  const commands = options.commands ?? [];
  const headerSize = wide ? 32 : 28;
  const commandBytes = commands.reduce((total, item) => total + item.length, 0);
  const bytes = new Uint8Array(headerSize + commandBytes + 16);
  const view = new DataView(bytes.buffer);
  const cpu = options.cpu ?? CPU.arm64;
  view.setUint32(0, wide ? 0xfeedfacf : 0xfeedface, true);
  view.setUint32(4, cpu.type, true);
  view.setUint32(8, cpu.subtype, true);
  view.setUint32(12, options.fileType ?? FILE_TYPE.execute, true);
  view.setUint32(16, commands.length, true);
  view.setUint32(20, commandBytes, true);
  let offset = headerSize;
  for (const command of commands) {
    bytes.set(command, offset);
    offset += command.length;
  }
  return bytes;
};

/**
 * A FAT container whose slices start on 4 KiB boundaries. Headers are
 * big-endian unless `littleEndian` selects the swapped FAT_CIGAM magics.
 */
export const fatImage = (
  slices: readonly {
    readonly cpu: { readonly type: number; readonly subtype: number };
    readonly bytes: Uint8Array;
  }[],
  wide = false,
  littleEndian = false,
): Uint8Array => {
  const entrySize = wide ? 32 : 20;
  const offsets: number[] = [];
  let end = 4096;
  for (const slice of slices) {
    offsets.push(end);
    end += Math.ceil(slice.bytes.length / 4096) * 4096;
  }
  const bytes = new Uint8Array(end);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, wide ? 0xcafebabf : 0xcafebabe, littleEndian);
  view.setUint32(4, slices.length, littleEndian);
  slices.forEach((slice, index) => {
    const base = 8 + index * entrySize;
    const offset = offsets[index] ?? 0;
    view.setUint32(base, slice.cpu.type, littleEndian);
    view.setUint32(base + 4, slice.cpu.subtype, littleEndian);
    if (wide) {
      view.setBigUint64(base + 8, BigInt(offset), littleEndian);
      view.setBigUint64(base + 16, BigInt(slice.bytes.length), littleEndian);
      view.setUint32(base + 24, 12, littleEndian);
    } else {
      view.setUint32(base + 8, offset, littleEndian);
      view.setUint32(base + 12, slice.bytes.length, littleEndian);
      view.setUint32(base + 16, 12, littleEndian);
    }
    bytes.set(slice.bytes, offset);
  });
  return bytes;
};

/** In-memory `ReadAt` over one buffer. */
export const readerOf =
  (bytes: Uint8Array) =>
  (offset: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(bytes.subarray(offset, offset + length));
