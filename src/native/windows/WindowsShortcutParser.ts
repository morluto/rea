import { setImmediate } from "node:timers/promises";

import { assertArtifactReadActive } from "../../resources/index.js";
import type {
  InspectWindowsShortcutInput,
  WindowsShortcut,
  WindowsShortcutExtraDataBlock,
  WindowsShortcutIdListItem,
  WindowsShortcutIssue,
  WindowsShortcutStringField,
  WindowsShortcutUuidV1,
} from "../../domain/native/windowsShortcut.js";
import { WindowsShortcutResourceFailure } from "./WindowsShortcut.errors.js";
import {
  BinaryFormatFailure,
  BinaryReader,
} from "../../domain/binaryContainer.js";
import { malformedInput } from "../../domain/parseFailure.js";
import {
  formatWindowsGuid,
  SHELL_LINK_CLSID,
  SHELL_LINK_HEADER_BYTES,
} from "../../domain/windows/windowsShortcutHeader.js";
import { byteToHex } from "../../kernel/byteToHex.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

type Artifact = WindowsShortcut["artifact"];

const ENVIRONMENT_TARGET_SIGNATURE = 0xa0000001;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const UUID_UNIX_EPOCH = 0x01b21dd213814000n;
const ENTRIES_PER_YIELD = 32;
const LINK_INFO_FIXED_HEADER_BYTES = 0x1c;
const LINK_INFO_UNICODE_HEADER_BYTES = 0x24;
const VOLUME_UNICODE_LABEL_SELECTOR = 0x14;
const FORCE_NO_LINK_INFO = 0x00000100;
const DISABLE_LINK_PATH_TRACKING = 0x00100000;
// MS-SHLLINK §2.4 exempts COMMAND_LINE_ARGUMENTS from this format limit.
const MAX_STRING_DATA_CHARACTERS = 260;
/** ECMAScript Date range: 8.64e15 ms either side of the Unix epoch. */
const MAX_DATE_MS = 8_640_000_000_000_000n;

const isoFromUnsigned100ns = (ticks: bigint, epoch: bigint): string | null => {
  // Both stored clocks are unsigned and their epochs are millisecond-aligned.
  // Truncate before epoch subtraction so pre-1970 fractions stay in their
  // containing millisecond rather than rounding toward the Unix epoch.
  const unixMs = ticks / 10000n - epoch / 10000n;
  return unixMs < -MAX_DATE_MS || unixMs > MAX_DATE_MS
    ? null
    : new Date(Number(unixMs)).toISOString();
};

// MS-SHLLINK §2.1.1 identifies the ExtraData blocks declared by LinkFlags.
const LINK_FLAGS: ReadonlyArray<
  readonly [
    bit: number,
    name: string,
    requiredExtraSignature?: keyof typeof EXTRA_SIGNATURE_NAMES,
  ]
> = [
  [0x00000001, "HasLinkTargetIDList"],
  [0x00000002, "HasLinkInfo"],
  [0x00000004, "HasName"],
  [0x00000008, "HasRelativePath"],
  [0x00000010, "HasWorkingDir"],
  [0x00000020, "HasArguments"],
  [0x00000040, "HasIconLocation"],
  [0x00000080, "IsUnicode"],
  [FORCE_NO_LINK_INFO, "ForceNoLinkInfo"],
  [0x00000200, "HasExpString", 0xa0000001],
  [0x00000400, "RunInSeparateProcess"],
  [0x00001000, "HasDarwinID", 0xa0000006],
  [0x00002000, "RunAsUser"],
  [0x00004000, "HasExpIcon", 0xa0000007],
  [0x00008000, "NoPidlAlias"],
  [0x00020000, "RunWithShimLayer", 0xa0000008],
  [0x00040000, "ForceNoLinkTrack"],
  [0x00080000, "EnableTargetMetadata"],
  [DISABLE_LINK_PATH_TRACKING, "DisableLinkPathTracking"],
  [0x00200000, "DisableKnownFolderTracking"],
  [0x00400000, "DisableKnownFolderAlias"],
  [0x00800000, "AllowLinkToLink"],
  [0x01000000, "UnaliasOnSave"],
  [0x02000000, "PreferEnvironmentPath"],
  [0x04000000, "KeepLocalIDListForUNCTarget"],
];
const LINK_FLAG_NAMES = LINK_FLAGS.map(([bit, name]) => [bit, name] as const);

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

const EXTRA_SIGNATURE_NAMES = {
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
} as const;

// MS-SHLLINK §2.5.7 and §2.5.8 specify minimum sizes including the 8-byte header.
const OPAQUE_EXTRA_MIN_PAYLOAD_BYTES: Readonly<
  Partial<Record<number, number>>
> = {
  0xa0000008: 128,
  0xa0000009: 4,
};

const extraSignatureName = (signature: number): string | null => {
  const names: Readonly<Partial<Record<number, string>>> =
    EXTRA_SIGNATURE_NAMES;
  return names[signature] ?? null;
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

const namedBits = (
  raw: number,
  names: ReadonlyArray<readonly [number, string]>,
): { raw: number; decoded: string[] } => ({
  raw,
  decoded: names.flatMap(([bit, name]) => ((raw & bit) !== 0 ? [name] : [])),
});

const fileTime = (raw: bigint): WindowsShortcut["header"]["creation_time"] => {
  if (raw === 0n) return { raw: "0", iso8601: null };
  return {
    raw: raw.toString(10),
    iso8601: isoFromUnsigned100ns(raw, FILETIME_UNIX_EPOCH),
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
  reader: BinaryReader,
  offset: number,
): WindowsShortcutUuidV1 | null => {
  const { bytes } = reader;
  const timeHiVersion = reader.u16(offset + 6);
  if (timeHiVersion >> 12 !== 1) return null;
  // RFC 4122 variant: clock_seq_hi_and_reserved must have top bits 10.
  if (((bytes[offset + 8] ?? 0) & 0xc0) !== 0x80) return null;
  const timeLow = BigInt(reader.u32(offset));
  const timeMid = BigInt(reader.u16(offset + 4));
  const timeHi = BigInt(timeHiVersion & 0x0fff);
  const timestamp = (timeHi << 48n) | (timeMid << 32n) | timeLow;
  return {
    evidence_kind: "derived",
    version: 1,
    mac: [...bytes.subarray(offset + 10, offset + 16)]
      .map((byte) => byteToHex(byte))
      .join(":"),
    timestamp_iso8601: isoFromUnsigned100ns(timestamp, UUID_UNIX_EPOCH),
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

const extensionOf = (path: string, ansi: boolean): string | null => {
  if (path.length === 0) return null;
  const normalized = path.replaceAll("/", "\\");
  const slash = normalized.lastIndexOf("\\");
  const name = slash === -1 ? normalized : normalized.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot);
  return ansi && !isAscii(extension) ? null : extension.toLowerCase();
};

const foldPath = (path: string): string =>
  path.replaceAll("/", "\\").toLowerCase();

/** `\\?\` and `\\.\` paths reach Windows verbatim, so their segments are kept as written. */
const DEVICE_PATH = /^\\\\[?.]\\/u;

/**
 * Compare form of a full path, from the text alone: no path is ever opened.
 * Folds case and separators, drops repeated separators and `.` segments, and
 * lets `..` remove one segment but never the drive or UNC `\\server\share` root.
 */
const normalizePath = (path: string): string => {
  const folded = foldPath(path);
  if (DEVICE_PATH.test(folded)) return folded;
  const unc = folded.startsWith("\\\\");
  if (!unc && !/^[a-z]:\\/u.test(folded)) return folded;
  // Empty parts drop out first, so `\\server\\share` keeps its share in the root.
  const parts = folded
    .slice(unc ? 2 : 0)
    .split("\\")
    .filter((part) => part !== "");
  const root = parts.slice(0, unc ? 2 : 1);
  const segments: string[] = [];
  for (const part of parts.slice(root.length)) {
    if (part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return unc
    ? `\\\\${[...root, ...segments].join("\\")}`
    : `${root[0] ?? ""}\\${segments.join("\\")}`;
};

/** A drive or UNC path. Filenames, relative paths, and `%VAR%` forms name no fixed location. */
const isFullPath = (path: string): boolean =>
  /^(?:[a-z]:\\|\\\\)/u.test(foldPath(path));

/** An unexpanded `%VAR%` reference: the host is never consulted, so the path stays unresolved. */
const hasUnexpandedVariable = (path: string): boolean =>
  /%[^%\\/]+%/u.test(path);

/**
 * A recorded path and where its text came from. All-ASCII strings agree across
 * ANSI code pages, but an ASCII-valued trail byte in a multibyte string need not
 * name an ASCII character. A Latin1 projection preserves bytes, not decoded
 * character boundaries or case relationships.
 */
type RecordedPath = {
  /** Null when independently encoded parts cannot establish a joined path. */
  readonly path: string | null;
  /** Holds non-ASCII text projected from ANSI bytes. */
  readonly ansi: boolean;
  /** Holds non-ASCII UTF-16 text. */
  readonly unicode: boolean;
  /** A suffix may establish this even when its parent's identity is unknown. */
  readonly extension: string | null;
};

type TargetPathUncertainty = {
  local: boolean;
  network: boolean;
  suffix: boolean;
  environment: boolean;
};

const isAscii = (text: string): boolean =>
  [...text].every((char) => char <= "\u007f");

const recorded = (path: string, ansi: boolean) => {
  const nonAscii = !isAscii(path);
  return {
    path,
    ansi: ansi && nonAscii,
    unicode: !ansi && nonAscii,
    extension: extensionOf(path, ansi),
  };
};

/** Two paths compare as text only when their non-ASCII parts share one encoding. */
const comparableText = (left: RecordedPath, right: RecordedPath): boolean =>
  !((left.ansi || right.ansi) && (left.unicode || right.unicode));

/** Opaque ANSI bytes are not Unicode characters or path separators. */
const pathsDiffer = (
  left: RecordedPath,
  right: RecordedPath,
): boolean | null => {
  if (left.path === null || right.path === null || !comparableText(left, right))
    return null;
  if (!left.ansi && !right.ansi)
    return normalizePath(left.path) !== normalizePath(right.path);
  if (left.path === right.path) return false;
  // The identical prefix can end in a separator or a DBCS trail byte: either
  // way, only the following ASCII tails are compared. The prefix stays opaque.
  const asciiTail = (path: string) => {
    const at = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1;
    const name = path.slice(at);
    return name !== "" && name !== "." && name !== ".." && isAscii(name)
      ? { prefix: path.slice(0, at), name }
      : null;
  };
  const leftFile = asciiTail(left.path);
  const rightFile = asciiTail(right.path);
  return leftFile !== null &&
    rightFile !== null &&
    leftFile.prefix === rightFile.prefix
    ? leftFile.name.toLowerCase() !== rightFile.name.toLowerCase()
    : null;
};

const iconDiffersFromTarget = (
  icon: WindowsShortcut["string_data"]["icon_location"],
  targets: readonly RecordedPath[],
): boolean | null => {
  if (icon === null) return null;
  const text = icon.value;
  if (!isFullPath(text) || hasUnexpandedVariable(text)) return null;
  const iconPath = recorded(text, icon.encoding === "ansi");
  const fullTargets = targets.filter(
    (target) => target.path === null || isFullPath(target.path),
  );
  const differences = fullTargets.map((target) =>
    target.path !== null && hasUnexpandedVariable(target.path)
      ? null
      : pathsDiffer(target, iconPath),
  );
  if (differences.includes(false)) return false;
  return differences.length === 0 || differences.includes(null) ? null : true;
};

/** LinkInfo local and network base paths, each joined with CommonPathSuffix. */
const linkInfoTargets = (
  info: NonNullable<WindowsShortcut["link_info"]>,
  uncertainty: TargetPathUncertainty,
): RecordedPath[] => {
  // Neither joined LinkInfo path can be proven complete without its suffix.
  if (uncertainty.suffix) return [];
  const suffixText = info.common_path_suffix_unicode ?? info.common_path_suffix;
  const suffix =
    suffixText === null || suffixText.length === 0
      ? null
      : recorded(suffixText, info.common_path_suffix_unicode === null);
  // Each part keeps its own encoding, so an ASCII ANSI part never hides a
  // comparable Unicode part.
  const withSuffix = (base: ReturnType<typeof recorded>): RecordedPath => {
    if (suffix === null) return base;
    if (base.ansi || suffix.ansi)
      return {
        path: null,
        ansi: base.ansi || suffix.ansi,
        unicode: base.unicode || suffix.unicode,
        extension: suffix.extension,
      };
    return {
      path: `${base.path.replace(/\\$/u, "")}\\${suffix.path.replace(/^\\/u, "")}`,
      ansi: base.ansi || suffix.ansi,
      unicode: base.unicode || suffix.unicode,
      extension: suffix.extension,
    };
  };
  const values: RecordedPath[] = [];
  const local = info.local_base_path_unicode ?? info.local_base_path;
  if (
    !uncertainty.local &&
    local !== null &&
    (suffix !== null || local.length > 0)
  )
    values.push(
      withSuffix(recorded(local, info.local_base_path_unicode === null)),
    );
  const net = info.common_network_relative_link;
  if (!uncertainty.network && net !== null) {
    const share = net.net_name_unicode ?? net.net_name;
    if (share !== null)
      values.push(withSuffix(recorded(share, net.net_name_unicode === null)));
  }
  return values;
};

const targetPaths = (
  report: {
    readonly header: WindowsShortcut["header"];
    readonly link_info: WindowsShortcut["link_info"];
    readonly string_data: WindowsShortcut["string_data"];
    readonly id_list: WindowsShortcut["id_list"];
    readonly extra_data: WindowsShortcut["extra_data"];
  },
  uncertainty: TargetPathUncertainty,
): RecordedPath[] => {
  const flags = report.header.link_flags.raw;
  const values: RecordedPath[] =
    report.link_info === null || (flags & FORCE_NO_LINK_INFO) !== 0
      ? []
      : linkInfoTargets(report.link_info, uncertainty);
  const relative = report.string_data.relative_path;
  if (relative !== null)
    values.push(recorded(relative.value, relative.encoding === "ansi"));
  if (report.id_list !== null) {
    const lastFile = [...report.id_list.items]
      .reverse()
      .find((item) => item.kind === "file_entry");
    // Type bit 0x04 marks a UTF-16LE name; otherwise the name is ANSI.
    if (lastFile?.kind === "file_entry")
      values.push(
        recorded(lastFile.short_name, (lastFile.type_byte & 0x04) === 0),
      );
  }
  if ((flags & DISABLE_LINK_PATH_TRACKING) !== 0) return values;
  // A stored literal target, never expanded: `%VAR%` text stays as written.
  for (const block of report.extra_data.blocks) {
    if (block.decoded.kind !== "environment_variable") continue;
    const unicode = block.decoded.target_unicode.length > 0;
    const stored = unicode
      ? block.decoded.target_unicode
      : block.decoded.target_ansi;
    if (stored.length > 0) values.push(recorded(stored, !unicode));
  }
  return values;
};

const observationsOf = (
  report: Pick<
    WindowsShortcut,
    "header" | "link_info" | "string_data" | "id_list" | "extra_data"
  >,
  uncertainty: TargetPathUncertainty,
  stopped: boolean,
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
  const targets = targetPaths(report, uncertainty);
  const flags = report.header.link_flags.raw;
  // Keep the existing conservative uncertainty when an early stop may have
  // prevented later eligible fields from being examined.
  const linkInfoRelevant = stopped || (flags & FORCE_NO_LINK_INFO) === 0;
  const environmentRelevant =
    stopped || (flags & DISABLE_LINK_PATH_TRACKING) === 0;
  const targetPathUnknown =
    (linkInfoRelevant &&
      (uncertainty.local || uncertainty.network || uncertainty.suffix)) ||
    (environmentRelevant && uncertainty.environment);
  const iconDifference = iconDiffersFromTarget(
    report.string_data.icon_location,
    targets,
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
      extension: targetPathUnknown ? null : (targets[0]?.extension ?? null),
    },
    {
      kind: "show_command_minimized",
      evidence_kind: "derived",
      value: report.header.show_command.raw === 7,
    },
    {
      kind: "icon_location_differs_from_target",
      evidence_kind: "derived",
      value:
        targetPathUnknown && iconDifference === true ? null : iconDifference,
    },
  ];
};

const decodeIdListItem = (
  data: Buffer,
  offset: number,
  size: number,
): WindowsShortcutIdListItem => {
  const typeByte = data.length === 0 ? 0 : (data[0] ?? 0);
  const raw = (): WindowsShortcutIdListItem => ({
    kind: "raw",
    offset,
    size,
    type_byte: typeByte,
    sha256: sha256Hex(data),
  });
  if (typeByte === 0x1f && data.length >= 18) {
    return {
      kind: "root_folder",
      offset,
      size,
      type_byte: typeByte,
      sort_index: data[1] ?? 0,
      folder_id: formatWindowsGuid(
        new BinaryReader(data, true, "windows-shortcut"),
        2,
      ),
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
      file_size: new BinaryReader(data, true, "windows-shortcut").u32(2),
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
  pathUncertainty: TargetPathUncertainty;
};

/** A declared preferred path that could not be decoded cannot be treated as absent. */
const selectedPathUnreadable = (
  ansiOffset: number,
  ansi: string | null,
  unicodeOffset: number,
  unicode: string | null,
): boolean =>
  (unicodeOffset !== 0 && unicode === null) ||
  (unicode === null && ansiOffset !== 0 && ansi === null);

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

/** Charge the retained source text bytes, excluding framing. */
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
  field: number,
  walk: Walk,
  minimum = 0,
): string | null => {
  if (offset === 0) return null;
  if (offset < minimum || offset >= view.length) {
    note(
      walk,
      "malformed_structure",
      base + field,
      "ANSI string offset is outside the data area",
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
  charge(walk, end);
  return slice.subarray(0, end).toString("latin1");
};

const readUtf16At = (
  view: Buffer,
  base: number,
  offset: number,
  field: number,
  walk: Walk,
  minimum = 0,
): string | null => {
  if (offset === 0) return null;
  if (offset < minimum || offset >= view.length) {
    note(
      walk,
      "malformed_structure",
      base + field,
      "Unicode string offset is outside the data area",
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
  charge(walk, end);
  return slice.subarray(0, end).toString("utf16le");
};

const parseVolume = (
  linkInfo: BinaryReader,
  base: number,
  offset: number,
  field: number,
  walk: Walk,
): NonNullable<WindowsShortcut["link_info"]>["volume"] => {
  if (offset === 0) return null;
  const view = linkInfo.bytes;
  if (!fits(view, offset, 16)) {
    note(
      walk,
      "truncated",
      offset < view.length ? base + offset : base + field,
      "VolumeID is truncated",
    );
    return null;
  }
  const size = linkInfo.u32(offset);
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
  const reader = new BinaryReader(volume, linkInfo.little, linkInfo.format);
  const labelOffset = reader.u32(12);
  // MS-SHLLINK 2.3.1: exactly 0x14 selects VolumeLabelOffsetUnicode, and that
  // field exists for no other value. The two label encodings never coexist.
  const hasUnicodeLabel = labelOffset === VOLUME_UNICODE_LABEL_SELECTOR;
  if (hasUnicodeLabel && size < 20)
    note(
      walk,
      "truncated",
      base + offset + 16,
      "VolumeID ends before VolumeLabelOffsetUnicode",
    );
  return {
    drive_type: driveType(reader.u32(4)),
    serial: reader.u32(8).toString(16).toUpperCase().padStart(8, "0"),
    label: hasUnicodeLabel
      ? null
      : readAnsiAt(volume, base + offset, labelOffset, 12, walk, 16),
    label_unicode:
      hasUnicodeLabel && size >= 20
        ? readUtf16At(volume, base + offset, reader.u32(16), 16, walk, 20)
        : null,
  };
};

const parseNetwork = (
  linkInfo: BinaryReader,
  base: number,
  offset: number,
  field: number,
  walk: Walk,
): NonNullable<
  WindowsShortcut["link_info"]
>["common_network_relative_link"] => {
  if (offset === 0) return null;
  const view = linkInfo.bytes;
  if (!fits(view, offset, 20)) {
    note(
      walk,
      "truncated",
      offset < view.length ? base + offset : base + field,
      "CommonNetworkRelativeLink is truncated",
    );
    return null;
  }
  const size = linkInfo.u32(offset);
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
  const reader = new BinaryReader(block, linkInfo.little, linkInfo.format);
  // MS-SHLLINK 2.3.2: DeviceNameOffset (and its Unicode twin) are only
  // meaningful when ValidDevice is set; otherwise the fields are ignored.
  const flags = reader.u32(4);
  const validDevice = (flags & 0x1) !== 0;
  const validNetType = (flags & 0x2) !== 0;
  const netNameOffset = reader.u32(8);
  const deviceNameOffset = validDevice ? reader.u32(12) : 0;
  const declaresUnicode = netNameOffset > 0x14;
  if (declaresUnicode && size < 0x1c)
    note(
      walk,
      "truncated",
      base + offset + 20,
      "CommonNetworkRelativeLink ends before its declared Unicode offsets",
    );
  const unicode = declaresUnicode && size >= 0x1c;
  const netNameOffsetUnicode = unicode ? reader.u32(20) : 0;
  const deviceNameOffsetUnicode = unicode && validDevice ? reader.u32(24) : 0;
  // If the optional header is truncated, keep readable ANSI data after the
  // fixed header while the existing truncation issue marks coverage partial.
  const dataOffset = unicode ? 0x1c : 0x14;
  const result = {
    net_name: readAnsiAt(
      block,
      base + offset,
      netNameOffset,
      8,
      walk,
      dataOffset,
    ),
    net_name_unicode: readUtf16At(
      block,
      base + offset,
      netNameOffsetUnicode,
      20,
      walk,
      dataOffset,
    ),
    device_name: readAnsiAt(
      block,
      base + offset,
      deviceNameOffset,
      12,
      walk,
      dataOffset,
    ),
    device_name_unicode: readUtf16At(
      block,
      base + offset,
      deviceNameOffsetUnicode,
      24,
      walk,
      dataOffset,
    ),
    network_provider_type: validNetType ? reader.u32(16) : null,
  };
  walk.pathUncertainty.network ||=
    (declaresUnicode && !unicode) ||
    selectedPathUnreadable(
      netNameOffset,
      result.net_name,
      netNameOffsetUnicode,
      result.net_name_unicode,
    );
  return result;
};

const parseLinkInfo = (
  file: BinaryReader,
  walk: Walk,
): WindowsShortcut["link_info"] => {
  const { bytes } = file;
  if (!fits(bytes, walk.offset, 8)) {
    note(walk, "truncated", walk.offset, "LinkInfo is truncated", true);
    return null;
  }
  const size = file.u32(walk.offset);
  if (size < LINK_INFO_FIXED_HEADER_BYTES || !fits(bytes, walk.offset, size)) {
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
  const reader = new BinaryReader(view, file.little, file.format);
  const headerSize = reader.u32(4);
  const declaresUnicodeOffsets = headerSize >= LINK_INFO_UNICODE_HEADER_BYTES;
  if (
    headerSize > size ||
    (headerSize !== LINK_INFO_FIXED_HEADER_BYTES && !declaresUnicodeOffsets)
  )
    note(
      walk,
      "malformed_structure",
      walk.offset + 4,
      `LinkInfoHeaderSize ${String(headerSize)} must be 0x1C or at least 0x24 and fit within LinkInfoSize (${String(size)})`,
    );
  const flags = reader.u32(8);
  const volumeOffset = reader.u32(12);
  const localOffset = reader.u32(16);
  const networkOffset = reader.u32(20);
  const suffixOffset = reader.u32(24);
  const hasUnicodeOffsets =
    declaresUnicodeOffsets && size >= LINK_INFO_UNICODE_HEADER_BYTES;
  const localUnicodeOffset = hasUnicodeOffsets ? reader.u32(28) : 0;
  const suffixUnicodeOffset = hasUnicodeOffsets ? reader.u32(32) : 0;
  // A declared HeaderSize below the mandatory 0x1C must not expose those
  // fields as string data. Larger declared headers, including reserved
  // 0x1D..0x23 sizes, keep their own end as the floor.
  const stringOffset = Math.max(headerSize, LINK_INFO_FIXED_HEADER_BYTES);
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
        ? parseVolume(reader, walk.offset, volumeOffset, 12, walk)
        : null,
    local_base_path:
      (flags & 0x1) !== 0
        ? readAnsiAt(view, walk.offset, localOffset, 16, walk, stringOffset)
        : null,
    local_base_path_unicode:
      (flags & 0x1) !== 0
        ? readUtf16At(
            view,
            walk.offset,
            localUnicodeOffset,
            28,
            walk,
            stringOffset,
          )
        : null,
    common_network_relative_link:
      (flags & 0x2) !== 0
        ? parseNetwork(reader, walk.offset, networkOffset, 20, walk)
        : null,
    common_path_suffix: readAnsiAt(
      view,
      walk.offset,
      suffixOffset,
      24,
      walk,
      stringOffset,
    ),
    common_path_suffix_unicode: readUtf16At(
      view,
      walk.offset,
      suffixUnicodeOffset,
      32,
      walk,
      stringOffset,
    ),
  };
  walk.pathUncertainty.local ||=
    (flags & 0x1) !== 0 &&
    selectedPathUnreadable(
      localOffset,
      info.local_base_path,
      localUnicodeOffset,
      info.local_base_path_unicode,
    );
  walk.pathUncertainty.suffix ||= selectedPathUnreadable(
    suffixOffset,
    info.common_path_suffix,
    suffixUnicodeOffset,
    info.common_path_suffix_unicode,
  );
  walk.pathUncertainty.network ||=
    (flags & 0x2) !== 0 &&
    networkOffset !== 0 &&
    info.common_network_relative_link === null;
  walk.offset += size;
  return info;
};

const parseStringField = (
  reader: BinaryReader,
  walk: Walk,
  unicode: boolean,
  label: string,
): WindowsShortcutStringField | null => {
  const offset = walk.offset;
  const payloadOffset = offset + 2;
  let count: number | undefined;
  try {
    count = reader.u16(offset);
    const payloadBytes = count * (unicode ? 2 : 1);
    const payload = reader.range(payloadOffset, payloadBytes, label);
    if (
      label !== "COMMAND_LINE_ARGUMENTS" &&
      count > MAX_STRING_DATA_CHARACTERS
    )
      note(
        walk,
        "malformed_structure",
        offset,
        `${label} declares ${String(count)} characters, above the ${String(MAX_STRING_DATA_CHARACTERS)}-character StringData limit`,
      );
    charge(walk, payloadBytes);
    walk.offset = payloadOffset + payloadBytes;
    return {
      encoding: unicode ? "unicode" : "ansi",
      count_characters: count,
      byte_length: payloadBytes,
      value: payload.toString(unicode ? "utf16le" : "latin1"),
      location: { offset, bytes: 2 + payloadBytes },
    };
  } catch (cause: unknown) {
    if (!(cause instanceof BinaryFormatFailure)) throw cause;
    const oddUnicodePayload =
      count !== undefined &&
      unicode &&
      (reader.bytes.length - payloadOffset) % 2 === 1;
    note(
      walk,
      oddUnicodePayload ? "odd_unicode_length" : "truncated",
      offset,
      `${label} ${count === undefined ? "CountCharacters is" : "string bytes are"} truncated`,
      true,
    );
    return null;
  }
};

// MS-SHLLINK 2.5 defines exact sizes for these decoded blocks.
const FIXED_EXTRA_PAYLOAD_BYTES: Readonly<Partial<Record<number, number>>> = {
  0xa0000001: 780,
  0xa0000003: 88,
  0xa0000004: 4,
  0xa0000005: 8,
  0xa0000007: 780,
  0xa000000b: 20,
};

const environmentTargets = (
  payload: Buffer,
): { target_ansi: string; target_unicode: string } => {
  return {
    target_ansi: latin1Z(payload.subarray(0, 260)),
    target_unicode: utf16Z(payload.subarray(260, 780)),
  };
};

const decodeExtra = (
  signature: number,
  reader: BinaryReader,
  walk: Walk,
  offset: number,
): WindowsShortcutExtraDataBlock["decoded"] => {
  const { bytes: payload } = reader;
  const isEnvironmentTarget = signature === ENVIRONMENT_TARGET_SIGNATURE;
  const expectedBytes = FIXED_EXTRA_PAYLOAD_BYTES[signature];
  if (expectedBytes !== undefined && payload.length !== expectedBytes) {
    walk.pathUncertainty.environment ||= isEnvironmentTarget;
    note(
      walk,
      payload.length < expectedBytes ? "truncated" : "malformed_structure",
      offset,
      `${extraSignatureName(signature)} requires a ${expectedBytes + 8}-byte block, got ${payload.length + 8} bytes`,
    );
    return { kind: "raw", bytes: payload.length, sha256: sha256Hex(payload) };
  }
  if (isEnvironmentTarget || signature === 0xa0000007) {
    const targets = environmentTargets(payload);
    charge(
      walk,
      targets.target_ansi.length + targets.target_unicode.length * 2,
    );
    return {
      kind: isEnvironmentTarget ? "environment_variable" : "icon_environment",
      ...targets,
    };
  }
  if (signature === 0xa0000003) {
    const length = reader.u32(0);
    const version = reader.u32(4);
    if (length !== 0x58 || version !== 0) {
      note(
        walk,
        "malformed_structure",
        offset,
        `TrackerDataBlock header is unsupported (Length 0x${length.toString(16)}, Version ${String(version)})`,
      );
      return { kind: "raw", bytes: payload.length, sha256: sha256Hex(payload) };
    }
    const machine = latin1Z(payload.subarray(8, 24));
    charge(walk, machine.length);
    const droid0 = formatWindowsGuid(reader, 24);
    const droid1 = formatWindowsGuid(reader, 40);
    const birth0 = formatWindowsGuid(reader, 56);
    const birth1 = formatWindowsGuid(reader, 72);
    return {
      kind: "tracker",
      machine_id: machine,
      droid: [droid0, droid1],
      birth_droid: [birth0, birth1],
      droid_uuid_v1: [uuidV1(reader, 24), uuidV1(reader, 40)],
      birth_droid_uuid_v1: [uuidV1(reader, 56), uuidV1(reader, 72)],
    };
  }
  if (signature === 0xa0000004) {
    return { kind: "console_fe", code_page: reader.u32(0) };
  }
  if (signature === 0xa0000005) {
    return {
      kind: "special_folder",
      folder_id: reader.u32(0),
      item_offset: reader.u32(4),
    };
  }
  if (signature === 0xa000000b) {
    return {
      kind: "known_folder",
      folder_id: formatWindowsGuid(reader, 0),
      item_offset: reader.u32(16),
    };
  }
  const minimum = OPAQUE_EXTRA_MIN_PAYLOAD_BYTES[signature];
  const belowMinimum = minimum !== undefined && payload.length < minimum;
  if (belowMinimum)
    note(
      walk,
      "malformed_structure",
      offset,
      `${extraSignatureName(signature)} payload is shorter than ${String(minimum)} bytes`,
    );
  return {
    kind: signature === 0xa0000009 && !belowMinimum ? "property_store" : "raw",
    bytes: payload.length,
    sha256: sha256Hex(payload),
  };
};

const parseIdList = async (
  file: BinaryReader,
  walk: Walk,
  maxItems: number,
  signal?: AbortSignal,
): Promise<WindowsShortcut["id_list"]> => {
  const { bytes } = file;
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
  const byteSize = file.u16(walk.offset);
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
  const itemStart = start + 2;
  const list = new BinaryReader(
    file.range(itemStart, byteSize, "LinkTargetIDList"),
    file.little,
    file.format,
  );
  let cursor = 0;
  const items: WindowsShortcutIdListItem[] = [];
  let terminated = false;
  let malformed = false;
  while (cursor + 2 <= byteSize) {
    if (items.length > 0 && items.length % ENTRIES_PER_YIELD === 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    const size = list.u16(cursor);
    if (size === 0) {
      cursor += 2;
      if (cursor < byteSize)
        note(
          walk,
          "malformed_structure",
          itemStart + cursor,
          "Bytes follow TerminalID inside the declared LinkTargetIDList",
        );
      terminated = true;
      break;
    }
    if (size < 2 || cursor + size > byteSize) {
      note(
        walk,
        "malformed_structure",
        itemStart + cursor,
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
    items.push(
      decodeIdListItem(
        list.range(cursor + 2, size - 2, "ItemID data"),
        itemStart + cursor,
        size,
      ),
    );
    cursor += size;
  }
  if (!terminated && !malformed)
    note(
      walk,
      "malformed_structure",
      itemStart + cursor,
      "LinkTargetIDList has no TerminalID inside its declared size",
    );
  walk.offset = itemStart + byteSize;
  return {
    location: { offset: start, bytes: 2 + byteSize },
    byte_size: byteSize,
    item_count: items.length,
    items,
  };
};

const parseExtraData = async (
  file: BinaryReader,
  walk: Walk,
  maxBlocks: number,
  signal?: AbortSignal,
): Promise<WindowsShortcut["extra_data"]> => {
  const { bytes } = file;
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
    const size = file.u32(walk.offset);
    // TerminalSize MUST be below 4; any such value ends ExtraData.
    if (size < 4) {
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
    const signature = fits(bytes, walk.offset, 8)
      ? file.u32(walk.offset + 4)
      : null;
    if (signature === null || !fits(bytes, walk.offset, size)) {
      walk.pathUncertainty.environment ||=
        signature === ENVIRONMENT_TARGET_SIGNATURE;
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
    const payload = new BinaryReader(
      file.range(walk.offset + 8, size - 8, "ExtraData payload"),
      file.little,
      file.format,
    );
    blocks.push({
      offset: walk.offset,
      size,
      signature,
      signature_name: extraSignatureName(signature),
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
  if (bytes.length < SHELL_LINK_HEADER_BYTES)
    throw malformedInput(
      "windows-shortcut",
      `File is ${String(bytes.length)} bytes, below the 76-byte ShellLinkHeader`,
    );
  const reader = new BinaryReader(bytes, true, "windows-shortcut");
  const headerSize = reader.u32(0);
  if (headerSize !== SHELL_LINK_HEADER_BYTES)
    throw malformedInput(
      "windows-shortcut",
      `HeaderSize ${String(headerSize)} is not 0x4C`,
      { offset: 0, field: "HeaderSize" },
    );
  const clsid = formatWindowsGuid(reader, 4);
  if (clsid !== SHELL_LINK_CLSID)
    throw malformedInput(
      "windows-shortcut",
      `LinkCLSID ${clsid} is not ${SHELL_LINK_CLSID}`,
      { offset: 4, field: "LinkCLSID" },
    );
  const flags = reader.u32(20);
  const unicode = (flags & 0x00000080) !== 0;
  const header: WindowsShortcut["header"] = {
    location: { offset: 0, bytes: SHELL_LINK_HEADER_BYTES },
    header_size: headerSize,
    clsid,
    link_flags: namedBits(flags, LINK_FLAG_NAMES),
    file_attributes: namedBits(reader.u32(24), FILE_ATTRIBUTE_NAMES),
    creation_time: fileTime(reader.word(28, 64)),
    access_time: fileTime(reader.word(36, 64)),
    write_time: fileTime(reader.word(44, 64)),
    file_size: reader.u32(52),
    icon_index: reader.i32(56),
    show_command: showCommand(reader.u32(60)),
    hotkey: hotKey(reader.u16(64)),
  };
  const walk: Walk = {
    offset: SHELL_LINK_HEADER_BYTES,
    issues: [],
    failingOffset: null,
    stopped: false,
    stringBytes: 0,
    maxStringBytes: input.max_string_bytes,
    pathUncertainty: {
      local: false,
      network: false,
      suffix: false,
      environment: false,
    },
  };
  const idList =
    (flags & 0x00000001) !== 0
      ? await parseIdList(reader, walk, input.max_id_list_items, signal)
      : null;
  const linkInfo =
    (flags & 0x00000002) !== 0 && !walk.stopped
      ? parseLinkInfo(reader, walk)
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
      const field = parseStringField(reader, walk, unicode, label);
      stringData[key] = field;
      if (field === null) break;
    }
  }
  const extraData = !walk.stopped
    ? await parseExtraData(reader, walk, input.max_extra_data_blocks, signal)
    : { blocks: [], terminal_offset: null };
  // The TerminalBlock ends the Shell Link. Appended bytes are not examined, so
  // the file is not completely covered; payloads are often hidden there.
  if (extraData.terminal_offset !== null && walk.offset < bytes.length)
    note(
      walk,
      "malformed_structure",
      walk.offset,
      `${String(bytes.length - walk.offset)} byte(s) follow the ExtraData TerminalBlock and are not part of the Shell Link`,
    );
  const signatures = new Set(extraData.blocks.map((block) => block.signature));
  const unseenBlocks = LINK_FLAGS.flatMap(([bit, flagName, signature]) =>
    signature !== undefined && (flags & bit) !== 0 && !signatures.has(signature)
      ? [{ signature, flagName, blockName: EXTRA_SIGNATURE_NAMES[signature] }]
      : [],
  );
  // Only a TerminalBlock proves the whole section was read. Without one an
  // unseen block is unknown, not absent.
  if (extraData.terminal_offset !== null) {
    for (const { flagName, blockName } of unseenBlocks)
      note(
        walk,
        "missing_extra_data_block",
        extraData.terminal_offset,
        `${flagName} is set and ${blockName} is absent`,
      );
  } else {
    walk.pathUncertainty.environment ||= unseenBlocks.some(
      ({ signature }) => signature === ENVIRONMENT_TARGET_SIGNATURE,
    );
    if (unseenBlocks.length > 0 && walk.issues.length === 0)
      note(walk, "truncated", walk.offset, "ExtraData TerminalBlock is absent");
  }
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
    observations: observationsOf(
      reportBase,
      walk.pathUncertainty,
      walk.stopped,
    ),
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
