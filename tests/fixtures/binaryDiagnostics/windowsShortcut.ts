/** Synthesize Shell Link bytes for parser, CLI, and MCP tests. */

export const SHELL_LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x46,
]);

export const MY_COMPUTER_CLSID = Buffer.from([
  0xe0, 0x4f, 0xd0, 0x20, 0xea, 0x3a, 0x69, 0x10, 0xa2, 0xd8, 0x08, 0x00, 0x2b,
  0x30, 0x30, 0x9d,
]);

/** 2024-01-15T12:00:00.000Z as FILETIME 100-nanosecond intervals. */
export const FIXTURE_FILETIME = 133497936000000000n;

export const LINK_FLAG = {
  HasLinkTargetIDList: 0x00000001,
  HasLinkInfo: 0x00000002,
  HasName: 0x00000004,
  HasRelativePath: 0x00000008,
  HasWorkingDir: 0x00000010,
  HasArguments: 0x00000020,
  HasIconLocation: 0x00000040,
  IsUnicode: 0x00000080,
  HasExpString: 0x00000200,
  HasExpIcon: 0x00004000,
} as const;

export const EXTRA_SIGNATURE = {
  EnvironmentVariable: 0xa0000001,
  Tracker: 0xa0000003,
  ConsoleFE: 0xa0000004,
  SpecialFolder: 0xa0000005,
  IconEnvironment: 0xa0000007,
  PropertyStore: 0xa0000009,
  KnownFolder: 0xa000000b,
} as const;

export const TRACKER_MAC = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
/** UUID timestamp 100ns since 1582-10-15 matching 2024-01-15T12:00:00.000Z. */
export const TRACKER_UUID_TIMESTAMP = 139289664000000000n;

export type FixtureIdListItem =
  | {
      readonly kind: "root";
      readonly sortIndex?: number;
      readonly folderId?: Buffer;
    }
  | { readonly kind: "volume"; readonly name: string }
  | {
      readonly kind: "file";
      readonly classType?: number;
      readonly fileSize?: number;
      readonly shortName: string;
    }
  | { readonly kind: "raw"; readonly data: Buffer };

export type FixtureLinkInfo = {
  readonly driveType?: number;
  readonly serial?: number;
  readonly label?: string;
  readonly localBasePath?: string;
  readonly commonPathSuffix?: string;
  readonly netName?: string;
  readonly deviceName?: string;
  readonly networkProviderType?: number;
};

export type FixtureExtraBlock =
  | {
      readonly kind: "environment";
      readonly ansi?: string;
      readonly unicode?: string;
    }
  | {
      readonly kind: "icon_environment";
      readonly ansi?: string;
      readonly unicode?: string;
    }
  | {
      readonly kind: "tracker";
      readonly machineId?: string;
      readonly droid?: readonly [Buffer, Buffer];
      readonly birthDroid?: readonly [Buffer, Buffer];
    }
  | {
      readonly kind: "known_folder";
      readonly folderId?: Buffer;
      readonly itemOffset?: number;
    }
  | {
      readonly kind: "special_folder";
      readonly folderId?: number;
      readonly itemOffset?: number;
    }
  | { readonly kind: "console_fe"; readonly codePage?: number }
  | { readonly kind: "property_store"; readonly payload?: Buffer }
  | {
      readonly kind: "unknown";
      readonly signature: number;
      readonly payload?: Buffer;
    };

export type WindowsShortcutFixtureOptions = {
  readonly headerSize?: number;
  readonly clsid?: Buffer;
  readonly flags?: number;
  readonly fileAttributes?: number;
  readonly creationTime?: bigint;
  readonly accessTime?: bigint;
  readonly writeTime?: bigint;
  readonly fileSize?: number;
  readonly iconIndex?: number;
  readonly showCommand?: number;
  readonly hotKey?: number;
  readonly unicode?: boolean;
  readonly idList?: readonly FixtureIdListItem[] | null;
  readonly linkInfo?: FixtureLinkInfo | null;
  readonly name?: string;
  readonly relativePath?: string;
  readonly workingDir?: string;
  readonly arguments?: string;
  readonly iconLocation?: string;
  readonly extraData?: readonly FixtureExtraBlock[];
  readonly terminalBlock?: boolean;
  readonly truncateAt?: number;
  readonly omitStringBytes?: number;
};

const ansiZ = (value: string): Buffer =>
  Buffer.concat([Buffer.from(value, "latin1"), Buffer.from([0])]);

const utf16z = (value: string): Buffer =>
  Buffer.concat([Buffer.from(value, "utf16le"), Buffer.alloc(2)]);

const padField = (
  value: string,
  bytes: number,
  encoding: "latin1" | "utf16le",
) => {
  const field = Buffer.alloc(bytes);
  Buffer.from(value, encoding).copy(field);
  return field;
};

const writeU32 = (target: Buffer, offset: number, value: number): void => {
  target.writeUInt32LE(value >>> 0, offset);
};

const writeU64 = (target: Buffer, offset: number, value: bigint): void => {
  target.writeBigUInt64LE(value, offset);
};

/** Windows GUID bytes for a version-1 UUID with the supplied node and timestamp. */
export const uuidV1Bytes = (
  timestamp100ns: bigint,
  clockSeq: number,
  node: Buffer,
): Buffer => {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(Number(timestamp100ns & 0xffffffffn), 0);
  bytes.writeUInt16LE(Number((timestamp100ns >> 32n) & 0xffffn), 4);
  bytes.writeUInt16LE(Number((timestamp100ns >> 48n) & 0x0fffn) | 0x1000, 6);
  bytes[8] = ((clockSeq >> 8) & 0x3f) | 0x80;
  bytes[9] = clockSeq & 0xff;
  node.copy(bytes, 10, 0, 6);
  return bytes;
};

const defaultTrackerGuid = (clockSeq: number): Buffer =>
  uuidV1Bytes(TRACKER_UUID_TIMESTAMP, clockSeq, TRACKER_MAC);

const itemBytes = (item: FixtureIdListItem): Buffer => {
  if (item.kind === "raw") {
    const size = Buffer.alloc(2);
    size.writeUInt16LE(item.data.length + 2, 0);
    return Buffer.concat([size, item.data]);
  }
  if (item.kind === "root") {
    const data = Buffer.alloc(18);
    data[0] = 0x1f;
    data[1] = item.sortIndex ?? 0x50;
    (item.folderId ?? MY_COMPUTER_CLSID).copy(data, 2);
    const size = Buffer.alloc(2);
    size.writeUInt16LE(20, 0);
    return Buffer.concat([size, data]);
  }
  if (item.kind === "volume") {
    const name = Buffer.from(`${item.name}\0`, "latin1");
    const data = Buffer.concat([Buffer.from([0x2f]), name]);
    const size = Buffer.alloc(2);
    size.writeUInt16LE(data.length + 2, 0);
    return Buffer.concat([size, data]);
  }
  const shortName = Buffer.from(`${item.shortName}\0`, "latin1");
  const padded =
    shortName.length % 2 === 0
      ? shortName
      : Buffer.concat([shortName, Buffer.from([0])]);
  const data = Buffer.alloc(12 + padded.length);
  data[0] = item.classType ?? 0x32;
  data.writeUInt32LE(item.fileSize ?? 0, 2);
  padded.copy(data, 12);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(data.length + 2, 0);
  return Buffer.concat([size, data]);
};

const idListBytes = (items: readonly FixtureIdListItem[]): Buffer => {
  const body = Buffer.concat([...items.map(itemBytes), Buffer.alloc(2)]);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length, 0);
  return Buffer.concat([size, body]);
};

const volumeIdBytes = (info: FixtureLinkInfo, unicode: boolean): Buffer => {
  const ansi = ansiZ(info.label ?? "VOL");
  const wide = unicode ? utf16z(info.label ?? "VOL") : Buffer.alloc(0);
  const header = unicode ? 20 : 16;
  const bytes = Buffer.alloc(header + ansi.length + wide.length);
  writeU32(bytes, 0, bytes.length);
  writeU32(bytes, 4, info.driveType ?? 3);
  writeU32(bytes, 8, info.serial ?? 0x1234abcd);
  writeU32(bytes, 12, unicode ? 0x14 : 0x10);
  if (unicode) writeU32(bytes, 16, header + ansi.length);
  ansi.copy(bytes, header);
  wide.copy(bytes, header + ansi.length);
  return bytes;
};

const networkLinkBytes = (info: FixtureLinkInfo, unicode: boolean): Buffer => {
  const netAnsi = ansiZ(info.netName ?? "\\\\server\\share");
  const deviceAnsi = ansiZ(info.deviceName ?? "Z:");
  const netWide = unicode
    ? utf16z(info.netName ?? "\\\\server\\share")
    : Buffer.alloc(0);
  const deviceWide = unicode
    ? utf16z(info.deviceName ?? "Z:")
    : Buffer.alloc(0);
  const header = unicode ? 0x1c : 0x14;
  const deviceAnsiOffset = header + netAnsi.length;
  const netWideOffset = deviceAnsiOffset + deviceAnsi.length;
  const deviceWideOffset = netWideOffset + netWide.length;
  const bytes = Buffer.alloc(deviceWideOffset + deviceWide.length);
  writeU32(bytes, 0, bytes.length);
  writeU32(bytes, 4, 0x3);
  writeU32(bytes, 8, header);
  writeU32(bytes, 12, deviceAnsiOffset);
  writeU32(bytes, 16, info.networkProviderType ?? 0x00020000);
  if (unicode) {
    writeU32(bytes, 20, netWideOffset);
    writeU32(bytes, 24, deviceWideOffset);
  }
  netAnsi.copy(bytes, header);
  deviceAnsi.copy(bytes, deviceAnsiOffset);
  netWide.copy(bytes, netWideOffset);
  deviceWide.copy(bytes, deviceWideOffset);
  return bytes;
};

const linkInfoBytes = (info: FixtureLinkInfo, unicode: boolean): Buffer => {
  const hasVolume =
    info.localBasePath !== undefined || info.label !== undefined;
  const hasNetwork =
    info.netName !== undefined || info.deviceName !== undefined;
  const flags = (hasVolume ? 0x1 : 0) | (hasNetwork ? 0x2 : 0) || 0x1;
  const headerSize = unicode ? 0x24 : 0x1c;
  const volume = flags & 0x1 ? volumeIdBytes(info, unicode) : Buffer.alloc(0);
  const localAnsi =
    flags & 0x1
      ? ansiZ(info.localBasePath ?? "C:\\target.exe")
      : Buffer.alloc(0);
  const network =
    flags & 0x2 ? networkLinkBytes(info, unicode) : Buffer.alloc(0);
  const suffixAnsi = ansiZ(info.commonPathSuffix ?? "");
  const localWide =
    unicode && flags & 0x1
      ? utf16z(info.localBasePath ?? "C:\\target.exe")
      : Buffer.alloc(0);
  const suffixWide = unicode
    ? utf16z(info.commonPathSuffix ?? "")
    : Buffer.alloc(0);
  let cursor = headerSize;
  const volumeOffset = flags & 0x1 ? cursor : 0;
  if (flags & 0x1) cursor += volume.length;
  const localOffset = flags & 0x1 ? cursor : 0;
  if (flags & 0x1) cursor += localAnsi.length;
  const networkOffset = flags & 0x2 ? cursor : 0;
  if (flags & 0x2) cursor += network.length;
  const suffixOffset = cursor;
  cursor += suffixAnsi.length;
  const localWideOffset = unicode && flags & 0x1 ? cursor : 0;
  if (unicode && flags & 0x1) cursor += localWide.length;
  const suffixWideOffset = unicode ? cursor : 0;
  if (unicode) cursor += suffixWide.length;
  const bytes = Buffer.alloc(cursor);
  writeU32(bytes, 0, cursor);
  writeU32(bytes, 4, headerSize);
  writeU32(bytes, 8, flags);
  writeU32(bytes, 12, volumeOffset);
  writeU32(bytes, 16, localOffset);
  writeU32(bytes, 20, networkOffset);
  writeU32(bytes, 24, suffixOffset);
  if (unicode) {
    writeU32(bytes, 28, localWideOffset);
    writeU32(bytes, 32, suffixWideOffset);
  }
  if (volumeOffset > 0) volume.copy(bytes, volumeOffset);
  if (localOffset > 0) localAnsi.copy(bytes, localOffset);
  if (networkOffset > 0) network.copy(bytes, networkOffset);
  suffixAnsi.copy(bytes, suffixOffset);
  if (localWideOffset > 0) localWide.copy(bytes, localWideOffset);
  if (suffixWideOffset > 0) suffixWide.copy(bytes, suffixWideOffset);
  return bytes;
};

/** StringData is counted, not NUL-terminated (MS-SHLLINK 2.4). */
const stringDataField = (value: string, unicode: boolean): Buffer => {
  const text = Buffer.from(value, unicode ? "utf16le" : "latin1");
  const count = Buffer.alloc(2);
  count.writeUInt16LE(value.length, 0);
  return Buffer.concat([count, text]);
};

const environmentBlock = (
  signature: number,
  ansi: string,
  unicode: string,
): Buffer => {
  const bytes = Buffer.alloc(0x314);
  writeU32(bytes, 0, 0x314);
  writeU32(bytes, 4, signature);
  padField(ansi, 260, "latin1").copy(bytes, 8);
  padField(unicode, 520, "utf16le").copy(bytes, 268);
  return bytes;
};

const extraBlockBytes = (block: FixtureExtraBlock): Buffer => {
  if (block.kind === "environment")
    return environmentBlock(
      EXTRA_SIGNATURE.EnvironmentVariable,
      block.ansi ??
        "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      block.unicode ??
        "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  if (block.kind === "icon_environment")
    return environmentBlock(
      EXTRA_SIGNATURE.IconEnvironment,
      block.ansi ?? "%SystemRoot%\\System32\\shell32.dll",
      block.unicode ?? "%SystemRoot%\\System32\\shell32.dll",
    );
  if (block.kind === "tracker") {
    const bytes = Buffer.alloc(0x60);
    writeU32(bytes, 0, 0x60);
    writeU32(bytes, 4, EXTRA_SIGNATURE.Tracker);
    writeU32(bytes, 8, 0x58);
    writeU32(bytes, 12, 0);
    padField(block.machineId ?? "WORKSTATION", 16, "latin1").copy(bytes, 16);
    const droid0 = block.droid?.[0] ?? defaultTrackerGuid(1);
    const droid1 = block.droid?.[1] ?? defaultTrackerGuid(2);
    const birth0 = block.birthDroid?.[0] ?? defaultTrackerGuid(3);
    const birth1 = block.birthDroid?.[1] ?? defaultTrackerGuid(4);
    droid0.copy(bytes, 32);
    droid1.copy(bytes, 48);
    birth0.copy(bytes, 64);
    birth1.copy(bytes, 80);
    return bytes;
  }
  if (block.kind === "known_folder") {
    const bytes = Buffer.alloc(0x1c);
    writeU32(bytes, 0, 0x1c);
    writeU32(bytes, 4, EXTRA_SIGNATURE.KnownFolder);
    (block.folderId ?? MY_COMPUTER_CLSID).copy(bytes, 8);
    writeU32(bytes, 24, block.itemOffset ?? 0);
    return bytes;
  }
  if (block.kind === "special_folder") {
    const bytes = Buffer.alloc(0x10);
    writeU32(bytes, 0, 0x10);
    writeU32(bytes, 4, EXTRA_SIGNATURE.SpecialFolder);
    writeU32(bytes, 8, block.folderId ?? 0x24);
    writeU32(bytes, 12, block.itemOffset ?? 0);
    return bytes;
  }
  if (block.kind === "console_fe") {
    const bytes = Buffer.alloc(0x0c);
    writeU32(bytes, 0, 0x0c);
    writeU32(bytes, 4, EXTRA_SIGNATURE.ConsoleFE);
    writeU32(bytes, 8, block.codePage ?? 437);
    return bytes;
  }
  if (block.kind === "property_store") {
    const payload = block.payload ?? Buffer.alloc(4);
    const bytes = Buffer.alloc(8 + payload.length);
    writeU32(bytes, 0, bytes.length);
    writeU32(bytes, 4, EXTRA_SIGNATURE.PropertyStore);
    payload.copy(bytes, 8);
    return bytes;
  }
  const payload = block.payload ?? Buffer.from([0xde, 0xad]);
  const bytes = Buffer.alloc(8 + payload.length);
  writeU32(bytes, 0, bytes.length);
  writeU32(bytes, 4, block.signature);
  payload.copy(bytes, 8);
  return bytes;
};

const defaultIdList = (): readonly FixtureIdListItem[] => [
  { kind: "root" },
  { kind: "volume", name: "C:\\" },
  {
    kind: "file",
    shortName: "POWERS~1.EXE",
    fileSize: 450560,
    classType: 0x32,
  },
];

const derivedFlags = (
  options: WindowsShortcutFixtureOptions,
  unicode: boolean,
): number => {
  if (options.flags !== undefined) return options.flags;
  let flags = 0;
  if (options.idList !== null) flags |= LINK_FLAG.HasLinkTargetIDList;
  if (options.linkInfo !== null) flags |= LINK_FLAG.HasLinkInfo;
  if (options.name !== undefined) flags |= LINK_FLAG.HasName;
  if (options.relativePath !== undefined) flags |= LINK_FLAG.HasRelativePath;
  if (options.workingDir !== undefined) flags |= LINK_FLAG.HasWorkingDir;
  if (options.arguments !== undefined) flags |= LINK_FLAG.HasArguments;
  if (options.iconLocation !== undefined) flags |= LINK_FLAG.HasIconLocation;
  if (unicode) flags |= LINK_FLAG.IsUnicode;
  const extra = options.extraData ?? [];
  if (extra.some((block) => block.kind === "environment"))
    flags |= LINK_FLAG.HasExpString;
  if (extra.some((block) => block.kind === "icon_environment"))
    flags |= LINK_FLAG.HasExpIcon;
  return flags;
};

/** Build one Shell Link. Omitted options produce a unicode PowerShell shortcut. */
export const windowsShortcutBytes = (
  options: WindowsShortcutFixtureOptions = {},
): Buffer => {
  const unicode = options.unicode ?? true;
  const name = options.name ?? "Windows PowerShell";
  const relativePath =
    options.relativePath ?? ".\\WindowsPowerShell\\v1.0\\powershell.exe";
  const workingDir = options.workingDir ?? "C:\\Windows\\System32";
  const argumentText =
    options.arguments ??
    '-WindowStyle Hidden -NoProfile -Command "Get-Process"';
  const iconLocation =
    options.iconLocation ?? "C:\\Windows\\System32\\shell32.dll";
  const idList =
    options.idList === undefined ? defaultIdList() : options.idList;
  const linkInfo =
    options.linkInfo === undefined
      ? {
          driveType: 3,
          serial: 0x9a8b7c6d,
          label: "OS",
          localBasePath:
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          commonPathSuffix: "",
        }
      : options.linkInfo;
  const extraData =
    options.extraData === undefined
      ? ([
          { kind: "environment" },
          { kind: "icon_environment" },
          { kind: "tracker" },
          { kind: "console_fe", codePage: 437 },
          { kind: "special_folder", folderId: 0x24 },
          { kind: "known_folder" },
          { kind: "property_store" },
        ] satisfies FixtureExtraBlock[])
      : options.extraData;
  const flags = derivedFlags(
    {
      ...options,
      name,
      relativePath,
      workingDir,
      arguments: argumentText,
      iconLocation,
    },
    unicode,
  );
  const header = Buffer.alloc(76);
  writeU32(header, 0, options.headerSize ?? 0x4c);
  (options.clsid ?? SHELL_LINK_CLSID).copy(header, 4);
  writeU32(header, 20, flags);
  writeU32(header, 24, options.fileAttributes ?? 0x20);
  writeU64(header, 28, options.creationTime ?? FIXTURE_FILETIME);
  writeU64(header, 36, options.accessTime ?? FIXTURE_FILETIME);
  writeU64(header, 44, options.writeTime ?? FIXTURE_FILETIME);
  writeU32(header, 52, options.fileSize ?? 450560);
  header.writeInt32LE(options.iconIndex ?? 0, 56);
  writeU32(header, 60, options.showCommand ?? 7);
  header.writeUInt16LE(options.hotKey ?? 0, 64);
  const parts: Buffer[] = [header];
  if (flags & LINK_FLAG.HasLinkTargetIDList && idList !== null)
    parts.push(idListBytes(idList));
  if (flags & LINK_FLAG.HasLinkInfo && linkInfo !== null)
    parts.push(linkInfoBytes(linkInfo, unicode));
  const strings: Buffer[] = [];
  if (flags & LINK_FLAG.HasName) strings.push(stringDataField(name, unicode));
  if (flags & LINK_FLAG.HasRelativePath)
    strings.push(stringDataField(relativePath, unicode));
  if (flags & LINK_FLAG.HasWorkingDir)
    strings.push(stringDataField(workingDir, unicode));
  if (flags & LINK_FLAG.HasArguments)
    strings.push(stringDataField(argumentText, unicode));
  if (flags & LINK_FLAG.HasIconLocation)
    strings.push(stringDataField(iconLocation, unicode));
  let stringBytes = Buffer.concat(strings);
  if (options.omitStringBytes !== undefined)
    stringBytes = stringBytes.subarray(
      0,
      Math.max(0, stringBytes.length - options.omitStringBytes),
    );
  parts.push(stringBytes);
  for (const block of extraData) parts.push(extraBlockBytes(block));
  if (options.terminalBlock !== false) parts.push(Buffer.alloc(4));
  const bytes = Buffer.concat(parts);
  return options.truncateAt === undefined
    ? bytes
    : bytes.subarray(0, options.truncateAt);
};

export const powershellHiddenIconSpoofShortcut = (): Buffer =>
  windowsShortcutBytes();

export const networkShareShortcut = (): Buffer =>
  windowsShortcutBytes({
    showCommand: 1,
    flags:
      LINK_FLAG.HasLinkTargetIDList |
      LINK_FLAG.HasLinkInfo |
      LINK_FLAG.HasName |
      LINK_FLAG.HasRelativePath |
      LINK_FLAG.IsUnicode,
    name: "Share",
    relativePath: ".\\report.docx",
    linkInfo: {
      netName: "\\\\fileserver\\docs",
      deviceName: "Z:",
      networkProviderType: 0x00020000,
      commonPathSuffix: "report.docx",
    },
    extraData: [],
  });

export const trackerV1Shortcut = (): Buffer =>
  windowsShortcutBytes({
    extraData: [{ kind: "tracker" }],
  });

export const ansiShortcut = (): Buffer =>
  windowsShortcutBytes({
    unicode: false,
    extraData: [{ kind: "environment", ansi: "C:\\Windows\\notepad.exe" }],
  });

export const truncatedStringDataShortcut = (): Buffer =>
  windowsShortcutBytes({
    extraData: [],
    terminalBlock: false,
    omitStringBytes: 8,
  });

export const unknownExtraDataShortcut = (): Buffer =>
  windowsShortcutBytes({
    extraData: [
      { kind: "unknown", signature: 0xa0ffffff, payload: Buffer.from("xx") },
    ],
  });

export const wrongClsidShortcut = (): Buffer =>
  windowsShortcutBytes({
    clsid: Buffer.alloc(16),
    extraData: [],
  });
