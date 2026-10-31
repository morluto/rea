import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import type {
  InspectWindowsShortcutInput,
  WindowsShortcut,
  WindowsShortcutExtraDataBlock,
  WindowsShortcutIdListItem,
  WindowsShortcutIssue,
  WindowsShortcutStringField,
  WindowsShortcutUuidV1,
} from "../../domain/native/windowsShortcut.js";
import {
  WindowsShortcutFormatFailure,
  WindowsShortcutResourceFailure,
} from "./WindowsShortcut.errors.js";

type Artifact = WindowsShortcut["artifact"];

export const SHELL_LINK_CLSID = "00021401-0000-0000-C000-000000000046";
const HEADER_BYTES = 76;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const UUID_UNIX_EPOCH = 0x01b21dd213814000n;
const ENTRIES_PER_YIELD = 32;
/** ECMAScript Date range: 8.64e15 ms either side of the Unix epoch. */
const MAX_DATE_MS = 8_640_000_000_000_000n;

const isoFromUnixMs = (unixMs: bigint): string | null =>
  unixMs < -MAX_DATE_MS || unixMs > MAX_DATE_MS
    ? null
    : new Date(Number(unixMs)).toISOString();

const LINK_FLAG_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0x00000001, "HasLinkTargetIDList"],
  [0x00000002, "HasLinkInfo"],
  [0x00000004, "HasName"],
  [0x00000008, "HasRelativePath"],
  [0x00000010, "HasWorkingDir"],
  [0x00000020, "HasArguments"],
  [0x00000040, "HasIconLocation"],
  [0x00000080, "IsUnicode"],
  [0x00000100, "ForceNoLinkInfo"],
  [0x00000200, "HasExpString"],
  [0x00000400, "RunInSeparateProcess"],
  [0x00001000, "HasDarwinID"],
  [0x00002000, "RunAsUser"],
  [0x00004000, "HasExpIcon"],
  [0x00008000, "NoPidlAlias"],
  [0x00020000, "RunWithShimLayer"],
  [0x00040000, "ForceNoLinkTrack"],
  [0x00080000, "EnableTargetMetadata"],
  [0x00100000, "DisableLinkPathTracking"],
  [0x00200000, "DisableKnownFolderTracking"],
  [0x00400000, "DisableKnownFolderAlias"],
  [0x00800000, "AllowLinkToLink"],
  [0x01000000, "UnaliasOnSave"],
  [0x02000000, "PreferEnvironmentPath"],
  [0x04000000, "KeepLocalIDListForUNCTarget"],
];

const FILE_ATTRIBUTE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0x00000001, "READONLY"],
  [0x00000002, "HIDDEN"],
  [0x00000004, "SYSTEM"],
  [0x00000010, "DIRECTORY"],
  [0x00000020, "ARCHIVE"],
  [0x00000080, "NORMAL"],
  [0x00000100, "TEMPORARY"],
  [0x00000200, "SPARSE_FILE"],
  [0x00000400, "REPARSE_POINT"],
  [0x00000800, "COMPRESSED"],
  [0x00001000, "OFFLINE"],
  [0x00002000, "NOT_CONTENT_INDEXED"],
  [0x00004000, "ENCRYPTED"],
];

const DRIVE_TYPES = [
  "unknown",
  "no_root_dir",
  "removable",
  "fixed",
  "remote",
  "cdrom",
  "ramdisk",
] as const;

const EXTRA_SIGNATURE_NAMES: Readonly<Record<number, string>> = {
  0xa0000001: "EnvironmentVariableDataBlock",
  0xa0000002: "ConsoleDataBlock",
  0xa0000003: "TrackerDataBlock",
  0xa0000004: "ConsoleFEDataBlock",
  0xa0000005: "SpecialFolderDataBlock",
  0xa0000006: "DarwinDataBlock",
  0xa0000007: "IconEnvironmentDataBlock",
  0xa0000008: "ShimDataBlock",
  0xa0000009: "PropertyStoreDataBlock",
  0xa000000b: "KnownFolderDataBlock",
  0xa000000c: "VistaAndAboveIDListDataBlock",
};

const VIRTUAL_KEYS: Readonly<Record<number, string>> = {
  0x90: "NUMLOCK",
  0x91: "SCROLL",
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [0x30 + index, String(index)]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      0x41 + index,
      String.fromCharCode(65 + index),
    ]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      0x70 + index,
      `F${String(index + 1)}`,
    ]),
  ),
};

const LIMITATIONS = [
  "Rows reproduce the selected Shell Link bytes; they do not resolve, open, or execute the link target.",
  "ANSI strings use a byte-preserving Latin1 projection. The original system ANSI code page is unobserved.",
  "Volume serial, NetBIOS machine id, and Tracker droid values are recorded as stored. Host identity is not verified.",
];

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const namedBits = (
  raw: number,
  names: ReadonlyArray<readonly [number, string]>,
): { raw: number; decoded: string[] } => ({
  raw,
  decoded: names.flatMap(([bit, name]) => ((raw & bit) !== 0 ? [name] : [])),
});

const formatGuid = (bytes: Buffer, offset: number): string => {
  const d1 = bytes.readUInt32LE(offset).toString(16).padStart(8, "0");
  const d2 = bytes
    .readUInt16LE(offset + 4)
    .toString(16)
    .padStart(4, "0");
  const d3 = bytes
    .readUInt16LE(offset + 6)
    .toString(16)
    .padStart(4, "0");
  const d4 = bytes.subarray(offset + 8, offset + 10).toString("hex");
  const d5 = bytes.subarray(offset + 10, offset + 16).toString("hex");
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toUpperCase();
};

const fileTime = (raw: bigint): WindowsShortcut["header"]["creation_time"] => {
  if (raw === 0n) return { raw: "0", iso8601: null };
  return {
    raw: raw.toString(10),
    iso8601: isoFromUnixMs((raw - FILETIME_UNIX_EPOCH) / 10000n),
  };
};

const showCommand = (
  raw: number,
): WindowsShortcut["header"]["show_command"] => {
  if (raw === 3) return { raw, decoded: "maximized" };
  if (raw === 7) return { raw, decoded: "minimized" };
  return { raw, decoded: "normal" };
};

const hotKey = (raw: number): WindowsShortcut["header"]["hotkey"] => {
  const modifiers: Array<"shift" | "control" | "alt"> = [];
  const high = (raw >> 8) & 0xff;
  if ((high & 0x01) !== 0) modifiers.push("shift");
  if ((high & 0x02) !== 0) modifiers.push("control");
  if ((high & 0x04) !== 0) modifiers.push("alt");
  const virtualKey = raw & 0xff;
  if (raw === 0) {
    return {
      raw,
      modifiers: [],
      virtual_key: null,
      virtual_key_name: null,
    };
  }
  return {
    raw,
    modifiers,
    virtual_key: virtualKey,
    virtual_key_name: VIRTUAL_KEYS[virtualKey] ?? null,
  };
};

const latin1Z = (bytes: Buffer): string => {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("latin1");
};

/** Byte offset of the first UTF-16LE NUL code unit, or -1 when unterminated. */
const utf16TerminatorOf = (bytes: Buffer): number => {
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] === 0) return index;
  }
  return -1;
};

const utf16Z = (bytes: Buffer): string => {
  const end = utf16TerminatorOf(bytes);
  return bytes
    .subarray(0, end === -1 ? bytes.length - (bytes.length % 2) : end)
    .toString("utf16le");
};

const uuidV1 = (
  bytes: Buffer,
  offset: number,
): WindowsShortcutUuidV1 | null => {
  const timeHiVersion = bytes.readUInt16LE(offset + 6);
  if (timeHiVersion >> 12 !== 1) return null;
  const timeLow = BigInt(bytes.readUInt32LE(offset));
  const timeMid = BigInt(bytes.readUInt16LE(offset + 4));
  const timeHi = BigInt(timeHiVersion & 0x0fff);
  const timestamp = (timeHi << 48n) | (timeMid << 32n) | timeLow;
  return {
    evidence_kind: "derived",
    version: 1,
    mac: [...bytes.subarray(offset + 10, offset + 16)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(":"),
    timestamp_iso8601: isoFromUnixMs((timestamp - UUID_UNIX_EPOCH) / 10000n),
    timestamp_100ns: timestamp.toString(10),
  };
};

const driveType = (
  raw: number,
): {
  readonly raw: number;
  readonly name: (typeof DRIVE_TYPES)[number] | null;
} => ({
  raw,
  name: DRIVE_TYPES[raw] ?? null,
});

const extensionOf = (path: string | null | undefined): string | null => {
  if (path === undefined || path === null || path.length === 0) return null;
  const normalized = path.replaceAll("/", "\\");
  const slash = normalized.lastIndexOf("\\");
  const name = slash === -1 ? normalized : normalized.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
};

const normalizePath = (path: string): string =>
  path.replaceAll("/", "\\").toLowerCase();

const targetPaths = (report: {
  readonly link_info: WindowsShortcut["link_info"];
  readonly string_data: WindowsShortcut["string_data"];
  readonly id_list: WindowsShortcut["id_list"];
}): string[] => {
  const values: string[] = [];
  const info = report.link_info;
  if (info !== null) {
    const local = info.local_base_path_unicode ?? info.local_base_path;
    const suffix = info.common_path_suffix_unicode ?? info.common_path_suffix;
    if (local !== null && suffix !== null && suffix.length > 0)
      values.push(
        `${local.replace(/\\$/u, "")}\\${suffix.replace(/^\\/u, "")}`,
      );
    if (local !== null && local.length > 0) values.push(local);
    const net = info.common_network_relative_link;
    if (net !== null) {
      const share = net.net_name_unicode ?? net.net_name;
      if (share !== null && suffix !== null && suffix.length > 0)
        values.push(
          `${share.replace(/\\$/u, "")}\\${suffix.replace(/^\\/u, "")}`,
        );
      else if (share !== null) values.push(share);
    }
  }
  if (report.string_data.relative_path !== null)
    values.push(report.string_data.relative_path.value);
  if (report.id_list !== null) {
    const lastFile = [...report.id_list.items]
      .reverse()
      .find((item) => item.kind === "file_entry");
    if (lastFile?.kind === "file_entry") values.push(lastFile.short_name);
  }
  return values;
};

const observationsOf = (
  report: Pick<
    WindowsShortcut,
    "header" | "link_info" | "string_data" | "id_list"
  >,
): WindowsShortcut["observations"] => {
  const argumentsDeclared = (report.header.link_flags.raw & 0x00000020) !== 0;
  const argumentsField = report.string_data.arguments;
  // HasArguments set but the field was not read: presence and length stay unknown.
  const argumentsValue =
    argumentsField !== null
      ? argumentsField.value
      : argumentsDeclared
        ? null
        : "";
  const targets = targetPaths(report);
  const icon = report.string_data.icon_location?.value;
  const iconDiffers =
    icon === undefined || icon.length === 0 || targets.length === 0
      ? null
      : targets.every(
          (target) => normalizePath(target) !== normalizePath(icon),
        );
  return [
    {
      kind: "arguments_present",
      evidence_kind: "derived",
      value: argumentsValue === null ? null : argumentsValue.length > 0,
    },
    {
      kind: "argument_length",
      evidence_kind: "derived",
      characters: argumentsValue === null ? null : argumentsValue.length,
    },
    {
      kind: "target_extension",
      evidence_kind: "derived",
      extension: extensionOf(targets[0] ?? null),
    },
    {
      kind: "show_command_minimized",
      evidence_kind: "derived",
      value: report.header.show_command.raw === 7,
    },
    {
      kind: "icon_location_differs_from_target",
      evidence_kind: "derived",
      value: iconDiffers,
    },
  ];
};

const decodeIdListItem = (
  bytes: Buffer,
  offset: number,
  size: number,
): WindowsShortcutIdListItem => {
  const data = bytes.subarray(offset + 2, offset + size);
  const typeByte = data.length === 0 ? 0 : (data[0] ?? 0);
  const raw = (): WindowsShortcutIdListItem => ({
    kind: "raw",
    offset,
    size,
    type_byte: typeByte,
    sha256: sha256(data),
  });
  if (typeByte === 0x1f && data.length >= 18) {
    return {
      kind: "root_folder",
      offset,
      size,
      type_byte: typeByte,
      sort_index: data[1] ?? 0,
      folder_id: formatGuid(data, 2),
    };
  }
  if (typeByte === 0x2f && data.length >= 2) {
    const name = latin1Z(data.subarray(1));
    if (name.length === 0) return raw();
    return {
      kind: "volume",
      offset,
      size,
      type_byte: typeByte,
      name,
    };
  }
  if ((typeByte & 0x70) === 0x30 && data.length >= 14) {
    // Bit 0x04 marks a UTF-16LE name, which a Latin-1 read stops at the first zero byte.
    const nameBytes = data.subarray(12);
    const name =
      (typeByte & 0x04) !== 0 ? utf16Z(nameBytes) : latin1Z(nameBytes);
    if (name.length === 0 || /[\u0001-\u001f]/u.test(name)) return raw();
    return {
      kind: "file_entry",
      offset,
      size,
      type_byte: typeByte,
      entry_class: (typeByte & 0x01) !== 0 ? "directory" : "file",
      file_size: data.readUInt32LE(2),
      short_name: name,
    };
  }
  return raw();
};

type Walk = {
  offset: number;
  issues: WindowsShortcutIssue[];
  failingOffset: number | null;
  stopped: boolean;
  stringBytes: number;
  maxStringBytes: number;
};

const note = (
  walk: Walk,
  code: WindowsShortcutIssue["code"],
  offset: number,
  message: string,
  stop = false,
): void => {
  walk.issues.push({ code, offset, message });
  walk.failingOffset ??= offset;
  if (stop) walk.stopped = true;
};

const charge = (walk: Walk, bytes: number): void => {
  walk.stringBytes += bytes;
  if (walk.stringBytes > walk.maxStringBytes)
    throw new WindowsShortcutResourceFailure(
      "string_bytes",
      walk.maxStringBytes,
      `Shell Link strings exceed the ${String(walk.maxStringBytes)}-byte retained-text allowance`,
    );
};

const fits = (bytes: Buffer, offset: number, size: number): boolean =>
  offset >= 0 &&
  size >= 0 &&
  offset <= bytes.length &&
  size <= bytes.length - offset;

const readAnsiAt = (
  view: Buffer,
  base: number,
  offset: number,
  walk: Walk,
): string | null => {
  if (offset === 0) return null;
  if (offset >= view.length) {
    note(
      walk,
      "malformed_structure",
      base + offset,
      "ANSI string offset is outside LinkInfo",
    );
    return null;
  }
  const slice = view.subarray(offset);
  const end = slice.indexOf(0);
  if (end === -1) {
    note(
      walk,
      "malformed_structure",
      base + offset,
      "ANSI string has no NUL terminator inside its structure",
    );
    return null;
  }
  charge(walk, end + 1);
  return slice.subarray(0, end).toString("latin1");
};

const readUtf16At = (
  view: Buffer,
  base: number,
  offset: number,
  walk: Walk,
): string | null => {
  if (offset === 0) return null;
  if (offset >= view.length) {
    note(
      walk,
      "malformed_structure",
      base + offset,
      "Unicode string offset is outside LinkInfo",
    );
    return null;
  }
  const slice = view.subarray(offset);
  const end = utf16TerminatorOf(slice);
  if (end === -1) {
    note(
      walk,
      slice.length % 2 === 1 ? "odd_unicode_length" : "malformed_structure",
      base + offset,
      "Unicode string has no NUL terminator inside its structure",
    );
    return null;
  }
  charge(walk, end + 2);
  return slice.subarray(0, end).toString("utf16le");
};

const parseVolume = (
  view: Buffer,
  base: number,
  offset: number,
  walk: Walk,
): NonNullable<WindowsShortcut["link_info"]>["volume"] => {
  if (offset === 0) return null;
  if (!fits(view, offset, 16)) {
    note(walk, "truncated", base + offset, "VolumeID is truncated");
    return null;
  }
  const size = view.readUInt32LE(offset);
  if (size < 16 || !fits(view, offset, size)) {
    note(
      walk,
      "block_size_overrun",
      base + offset,
      "VolumeID size overruns LinkInfo",
    );
    return null;
  }
  const volume = view.subarray(offset, offset + size);
  const labelOffset = volume.readUInt32LE(12);
  const unicodeOffset =
    labelOffset >= 0x14 && size >= 20 ? volume.readUInt32LE(16) : 0;
  return {
    drive_type: driveType(volume.readUInt32LE(4)),
    serial: volume.readUInt32LE(8).toString(16).toUpperCase().padStart(8, "0"),
    label: readAnsiAt(volume, base + offset, labelOffset, walk),
    label_unicode:
      unicodeOffset > 0
        ? readUtf16At(volume, base + offset, unicodeOffset, walk)
        : null,
  };
};

const parseNetwork = (
  view: Buffer,
  base: number,
  offset: number,
  walk: Walk,
): NonNullable<
  WindowsShortcut["link_info"]
>["common_network_relative_link"] => {
  if (offset === 0) return null;
  if (!fits(view, offset, 20)) {
    note(
      walk,
      "truncated",
      base + offset,
      "CommonNetworkRelativeLink is truncated",
    );
    return null;
  }
  const size = view.readUInt32LE(offset);
  if (size < 20 || !fits(view, offset, size)) {
    note(
      walk,
      "block_size_overrun",
      base + offset,
      "CommonNetworkRelativeLink size overruns LinkInfo",
    );
    return null;
  }
  const block = view.subarray(offset, offset + size);
  const netNameOffset = block.readUInt32LE(8);
  const deviceNameOffset = block.readUInt32LE(12);
  const unicode = netNameOffset > 0x14 && size >= 0x1c;
  const netNameOffsetUnicode = unicode ? block.readUInt32LE(20) : 0;
  const deviceNameOffsetUnicode = unicode ? block.readUInt32LE(24) : 0;
  return {
    net_name: readAnsiAt(block, base + offset, netNameOffset, walk),
    net_name_unicode: readUtf16At(
      block,
      base + offset,
      netNameOffsetUnicode,
      walk,
    ),
    device_name: readAnsiAt(block, base + offset, deviceNameOffset, walk),
    device_name_unicode: readUtf16At(
      block,
      base + offset,
      deviceNameOffsetUnicode,
      walk,
    ),
    network_provider_type: block.readUInt32LE(16),
  };
};

const parseLinkInfo = (
  bytes: Buffer,
  walk: Walk,
): WindowsShortcut["link_info"] => {
  if (!fits(bytes, walk.offset, 8)) {
    note(walk, "truncated", walk.offset, "LinkInfo is truncated", true);
    return null;
  }
  const size = bytes.readUInt32LE(walk.offset);
  if (size < 0x1c || !fits(bytes, walk.offset, size)) {
    note(
      walk,
      "block_size_overrun",
      walk.offset,
      "LinkInfo size overruns the file",
      true,
    );
    return null;
  }
  const view = bytes.subarray(walk.offset, walk.offset + size);
  const headerSize = view.readUInt32LE(4);
  if (headerSize < 0x1c || headerSize > size)
    note(
      walk,
      "malformed_structure",
      walk.offset + 4,
      `LinkInfoHeaderSize ${String(headerSize)} is outside 0x1C..LinkInfoSize`,
    );
  const flags = view.readUInt32LE(8);
  const volumeOffset = view.readUInt32LE(12);
  const localOffset = view.readUInt32LE(16);
  const networkOffset = view.readUInt32LE(20);
  const suffixOffset = view.readUInt32LE(24);
  const unicode = headerSize >= 0x24 && view.length >= 0x24;
  const localUnicodeOffset = unicode ? view.readUInt32LE(28) : 0;
  const suffixUnicodeOffset = unicode ? view.readUInt32LE(32) : 0;
  const info: NonNullable<WindowsShortcut["link_info"]> = {
    location: { offset: walk.offset, bytes: size },
    header_size: headerSize,
    flags: {
      raw: flags,
      volume_id_and_local_base_path: (flags & 0x1) !== 0,
      common_network_relative_link_and_path_suffix: (flags & 0x2) !== 0,
    },
    volume:
      (flags & 0x1) !== 0
        ? parseVolume(view, walk.offset, volumeOffset, walk)
        : null,
    local_base_path:
      (flags & 0x1) !== 0
        ? readAnsiAt(view, walk.offset, localOffset, walk)
        : null,
    local_base_path_unicode:
      (flags & 0x1) !== 0
        ? readUtf16At(view, walk.offset, localUnicodeOffset, walk)
        : null,
    common_network_relative_link:
      (flags & 0x2) !== 0
        ? parseNetwork(view, walk.offset, networkOffset, walk)
        : null,
    common_path_suffix: readAnsiAt(view, walk.offset, suffixOffset, walk),
    common_path_suffix_unicode: readUtf16At(
      view,
      walk.offset,
      suffixUnicodeOffset,
      walk,
    ),
  };
  walk.offset += size;
  return info;
};

const parseStringField = (
  bytes: Buffer,
  walk: Walk,
  unicode: boolean,
  label: string,
): WindowsShortcutStringField | null => {
  if (!fits(bytes, walk.offset, 2)) {
    note(
      walk,
      "truncated",
      walk.offset,
      `${label} CountCharacters is truncated`,
      true,
    );
    return null;
  }
  const count = bytes.readUInt16LE(walk.offset);
  const unit = unicode ? 2 : 1;
  const payloadBytes = count * unit;
  if (unicode && payloadBytes % 2 === 1) {
    note(
      walk,
      "odd_unicode_length",
      walk.offset,
      `${label} Unicode payload is an odd length`,
      true,
    );
    return null;
  }
  if (!fits(bytes, walk.offset + 2, payloadBytes)) {
    const remaining = bytes.length - (walk.offset + 2);
    note(
      walk,
      remaining % 2 === 1 && unicode ? "odd_unicode_length" : "truncated",
      walk.offset,
      `${label} string bytes are truncated`,
      true,
    );
    return null;
  }
  const payload = bytes.subarray(
    walk.offset + 2,
    walk.offset + 2 + payloadBytes,
  );
  charge(walk, payloadBytes);
  const value = payload.toString(unicode ? "utf16le" : "latin1");
  const field: WindowsShortcutStringField = {
    encoding: unicode ? "unicode" : "ansi",
    count_characters: count,
    byte_length: payloadBytes,
    value,
    location: { offset: walk.offset, bytes: 2 + payloadBytes },
  };
  walk.offset += 2 + payloadBytes;
  return field;
};

const environmentTargets = (
  payload: Buffer,
): { target_ansi: string; target_unicode: string } | null => {
  if (payload.length < 780) return null;
  return {
    target_ansi: latin1Z(payload.subarray(0, 260)),
    target_unicode: utf16Z(payload.subarray(260, 780)),
  };
};

const decodeExtra = (
  signature: number,
  payload: Buffer,
  walk: Walk,
  offset: number,
): WindowsShortcutExtraDataBlock["decoded"] => {
  if (signature === 0xa0000001 || signature === 0xa0000007) {
    const targets = environmentTargets(payload);
    if (targets === null) {
      note(
        walk,
        "truncated",
        offset,
        "Environment ExtraData payload is shorter than 780 bytes",
      );
      return { kind: "raw", bytes: payload.length, sha256: sha256(payload) };
    }
    charge(
      walk,
      targets.target_ansi.length + targets.target_unicode.length * 2,
    );
    return {
      kind:
        signature === 0xa0000001 ? "environment_variable" : "icon_environment",
      ...targets,
    };
  }
  if (signature === 0xa0000003) {
    if (payload.length < 88) {
      note(
        walk,
        "truncated",
        offset,
        "TrackerDataBlock payload is shorter than 0x58 bytes",
      );
      return { kind: "raw", bytes: payload.length, sha256: sha256(payload) };
    }
    const machine = latin1Z(payload.subarray(8, 24));
    charge(walk, machine.length);
    const droid0 = formatGuid(payload, 24);
    const droid1 = formatGuid(payload, 40);
    const birth0 = formatGuid(payload, 56);
    const birth1 = formatGuid(payload, 72);
    return {
      kind: "tracker",
      machine_id: machine,
      droid: [droid0, droid1],
      birth_droid: [birth0, birth1],
      droid_uuid_v1: [uuidV1(payload, 24), uuidV1(payload, 40)],
      birth_droid_uuid_v1: [uuidV1(payload, 56), uuidV1(payload, 72)],
    };
  }
  if (signature === 0xa0000004) {
    if (payload.length < 4) {
      note(walk, "truncated", offset, "ConsoleFEDataBlock is truncated");
      return { kind: "raw", bytes: payload.length, sha256: sha256(payload) };
    }
    return { kind: "console_fe", code_page: payload.readUInt32LE(0) };
  }
  if (signature === 0xa0000005) {
    if (payload.length < 8) {
      note(walk, "truncated", offset, "SpecialFolderDataBlock is truncated");
      return { kind: "raw", bytes: payload.length, sha256: sha256(payload) };
    }
    return {
      kind: "special_folder",
      folder_id: payload.readUInt32LE(0),
      item_offset: payload.readUInt32LE(4),
    };
  }
  if (signature === 0xa000000b) {
    if (payload.length < 20) {
      note(walk, "truncated", offset, "KnownFolderDataBlock is truncated");
      return { kind: "raw", bytes: payload.length, sha256: sha256(payload) };
    }
    return {
      kind: "known_folder",
      folder_id: formatGuid(payload, 0),
      item_offset: payload.readUInt32LE(16),
    };
  }
  if (signature === 0xa0000009)
    return {
      kind: "property_store",
      bytes: payload.length,
      sha256: sha256(payload),
    };
  return { kind: "raw", bytes: payload.length, sha256: sha256(payload) };
};

const parseIdList = async (
  bytes: Buffer,
  walk: Walk,
  maxItems: number,
  signal?: AbortSignal,
): Promise<WindowsShortcut["id_list"]> => {
  if (!fits(bytes, walk.offset, 2)) {
    note(
      walk,
      "truncated",
      walk.offset,
      "LinkTargetIDList size is truncated",
      true,
    );
    return null;
  }
  const byteSize = bytes.readUInt16LE(walk.offset);
  const start = walk.offset;
  if (!fits(bytes, walk.offset + 2, byteSize)) {
    note(
      walk,
      "truncated",
      walk.offset,
      "LinkTargetIDList overruns the file",
      true,
    );
    return null;
  }
  const end = walk.offset + 2 + byteSize;
  let cursor = walk.offset + 2;
  const items: WindowsShortcutIdListItem[] = [];
  let terminated = false;
  let malformed = false;
  while (cursor + 2 <= end) {
    if (items.length > 0 && items.length % ENTRIES_PER_YIELD === 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    const size = bytes.readUInt16LE(cursor);
    if (size === 0) {
      cursor += 2;
      terminated = true;
      break;
    }
    if (size < 2 || cursor + size > end) {
      note(
        walk,
        "malformed_structure",
        cursor,
        "ItemID size overruns the IDList",
      );
      malformed = true;
      break;
    }
    if (items.length + 1 > maxItems)
      throw new WindowsShortcutResourceFailure(
        "id_list_items",
        maxItems,
        `LinkTargetIDList declares more than the ${String(maxItems)}-item allowance`,
      );
    items.push(decodeIdListItem(bytes, cursor, size));
    cursor += size;
  }
  if (!terminated && !malformed)
    note(
      walk,
      "malformed_structure",
      cursor,
      "LinkTargetIDList has no TerminalID inside its declared size",
    );
  walk.offset = end;
  return {
    location: { offset: start, bytes: 2 + byteSize },
    byte_size: byteSize,
    item_count: items.length,
    items,
  };
};

const parseExtraData = async (
  bytes: Buffer,
  walk: Walk,
  maxBlocks: number,
  signal?: AbortSignal,
): Promise<WindowsShortcut["extra_data"]> => {
  const blocks: WindowsShortcutExtraDataBlock[] = [];
  let terminalOffset: number | null = null;
  while (walk.offset < bytes.length) {
    if (blocks.length > 0 && blocks.length % ENTRIES_PER_YIELD === 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    if (!fits(bytes, walk.offset, 4)) {
      note(
        walk,
        "truncated",
        walk.offset,
        "ExtraData is truncated before a block size",
        true,
      );
      break;
    }
    const size = bytes.readUInt32LE(walk.offset);
    if (size === 0) {
      terminalOffset = walk.offset;
      walk.offset += 4;
      break;
    }
    if (size < 8) {
      note(
        walk,
        "malformed_structure",
        walk.offset,
        `ExtraData block size ${String(size)} is below 8 bytes`,
      );
      break;
    }
    if (!fits(bytes, walk.offset, size)) {
      note(
        walk,
        "block_size_overrun",
        walk.offset,
        "ExtraData block overruns the file",
        true,
      );
      break;
    }
    if (blocks.length + 1 > maxBlocks)
      throw new WindowsShortcutResourceFailure(
        "extra_data_blocks",
        maxBlocks,
        `ExtraData declares more than the ${String(maxBlocks)}-block allowance`,
      );
    const signature = bytes.readUInt32LE(walk.offset + 4);
    const payload = bytes.subarray(walk.offset + 8, walk.offset + size);
    blocks.push({
      offset: walk.offset,
      size,
      signature,
      signature_name: EXTRA_SIGNATURE_NAMES[signature] ?? null,
      decoded: decodeExtra(signature, payload, walk, walk.offset),
    });
    walk.offset += size;
  }
  if (blocks.length > 0 && terminalOffset === null)
    note(walk, "truncated", walk.offset, "ExtraData TerminalBlock is absent");
  return { blocks, terminal_offset: terminalOffset };
};

/**
 * Read one Shell Link without resolving or executing the target.
 * Yields to the event loop and honors cancellation every
 * `ENTRIES_PER_YIELD` IDList items or ExtraData blocks.
 */
export const parseWindowsShortcut = async (
  bytes: Buffer,
  artifact: Artifact,
  input: InspectWindowsShortcutInput,
  signal?: AbortSignal,
): Promise<WindowsShortcut> => {
  assertArtifactReadActive(signal);
  if (bytes.length < HEADER_BYTES)
    throw new WindowsShortcutFormatFailure(
      "malformed",
      `File is ${String(bytes.length)} bytes, below the 76-byte ShellLinkHeader`,
    );
  const headerSize = bytes.readUInt32LE(0);
  if (headerSize !== HEADER_BYTES)
    throw new WindowsShortcutFormatFailure(
      "malformed",
      `HeaderSize ${String(headerSize)} is not 0x4C`,
    );
  const clsid = formatGuid(bytes, 4);
  if (clsid !== SHELL_LINK_CLSID)
    throw new WindowsShortcutFormatFailure(
      "malformed",
      `LinkCLSID ${clsid} is not ${SHELL_LINK_CLSID}`,
    );
  const flags = bytes.readUInt32LE(20);
  const unicode = (flags & 0x00000080) !== 0;
  const header: WindowsShortcut["header"] = {
    location: { offset: 0, bytes: HEADER_BYTES },
    header_size: headerSize,
    clsid,
    link_flags: namedBits(flags, LINK_FLAG_NAMES),
    file_attributes: namedBits(bytes.readUInt32LE(24), FILE_ATTRIBUTE_NAMES),
    creation_time: fileTime(bytes.readBigUInt64LE(28)),
    access_time: fileTime(bytes.readBigUInt64LE(36)),
    write_time: fileTime(bytes.readBigUInt64LE(44)),
    file_size: bytes.readUInt32LE(52),
    icon_index: bytes.readInt32LE(56),
    show_command: showCommand(bytes.readUInt32LE(60)),
    hotkey: hotKey(bytes.readUInt16LE(64)),
  };
  const walk: Walk = {
    offset: HEADER_BYTES,
    issues: [],
    failingOffset: null,
    stopped: false,
    stringBytes: 0,
    maxStringBytes: input.max_string_bytes,
  };
  const idList =
    (flags & 0x00000001) !== 0
      ? await parseIdList(bytes, walk, input.max_id_list_items, signal)
      : null;
  const linkInfo =
    (flags & 0x00000002) !== 0 && !walk.stopped
      ? parseLinkInfo(bytes, walk)
      : null;
  const stringData: WindowsShortcut["string_data"] = {
    name: null,
    relative_path: null,
    working_dir: null,
    arguments: null,
    icon_location: null,
  };
  const stringFlags: ReadonlyArray<
    readonly [number, keyof WindowsShortcut["string_data"], string]
  > = [
    [0x00000004, "name", "NAME_STRING"],
    [0x00000008, "relative_path", "RELATIVE_PATH"],
    [0x00000010, "working_dir", "WORKING_DIR"],
    [0x00000020, "arguments", "COMMAND_LINE_ARGUMENTS"],
    [0x00000040, "icon_location", "ICON_LOCATION"],
  ];
  if (!walk.stopped) {
    for (const [bit, key, label] of stringFlags) {
      if ((flags & bit) === 0) continue;
      const field = parseStringField(bytes, walk, unicode, label);
      stringData[key] = field;
      if (field === null) break;
    }
  }
  const extraData = !walk.stopped
    ? await parseExtraData(bytes, walk, input.max_extra_data_blocks, signal)
    : { blocks: [], terminal_offset: null };
  const signatures = new Set(extraData.blocks.map((block) => block.signature));
  if ((flags & 0x00000200) !== 0 && !signatures.has(0xa0000001))
    note(
      walk,
      "missing_extra_data_block",
      extraData.terminal_offset ?? walk.offset,
      "HasExpString is set and EnvironmentVariableDataBlock is absent",
    );
  if ((flags & 0x00004000) !== 0 && !signatures.has(0xa0000007))
    note(
      walk,
      "missing_extra_data_block",
      extraData.terminal_offset ?? walk.offset,
      "HasExpIcon is set and IconEnvironmentDataBlock is absent",
    );
  const reportBase = {
    artifact,
    header,
    id_list: idList,
    link_info: linkInfo,
    string_data: stringData,
    extra_data: extraData,
  };
  const partial = walk.issues.length > 0;
  return {
    ...reportBase,
    observations: observationsOf(reportBase),
    coverage: {
      status: partial ? "partial" : "complete",
      reason: partial
        ? `${String(walk.issues.length)} Shell Link issue(s) affect reported rows; see issues`
        : null,
      examined_id_list_items: idList?.items.length ?? 0,
      examined_extra_data_blocks: extraData.blocks.length,
      failing_offset: walk.failingOffset,
    },
    issues: walk.issues,
    limitations: LIMITATIONS,
  };
};
