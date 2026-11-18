import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { ellipsisExcerpt } from "../domain/excerpt.js";
import { constants, zstdDecompressSync } from "node:zlib";

import { gunzip, isGzip } from "../domain/desktop/gzipDocument.js";
import { deb822Paragraphs } from "../domain/desktop/aptRepositories.js";
import {
  DEB_CONTROL_RELATIONSHIP_NAMES,
  DEB_MAINTAINER_SCRIPTS,
  DEB_RELATIONSHIP_FIELDS,
  debArchiveCompressionFromName,
  debArMemberRole,
  parseDebianRelationshipField,
  parseDebianVersion,
  type DebArMember,
  type DebControl,
  type DebPackage,
  type DebPackageIssue,
  type DebTarEntry,
  type InspectDebPackageInput,
} from "../domain/deb/debPackage.js";
import {
  DebPackageAllowanceFailure,
  DebPackageCapacityFailure,
  DebPackageFormatFailure,
} from "./DebPackage.errors.js";
import { decodeXz } from "./xzDecoder.js";

/** A refusal a member walk returns with the facts it read before stopping. */
type DebPackageReadFailure =
  | DebPackageFormatFailure
  | DebPackageCapacityFailure
  | DebPackageAllowanceFailure;

const AR_MAGIC = Buffer.from("!<arch>\n", "ascii");
const AR_HEADER = 60;
/**
 * Longest ar member name the reader resolves. GNU `/N` references can repeat
 * one string-table entry, and every resolved name is copied into the report,
 * so an unbounded name lets a small table expand into large report text.
 */
const MAX_AR_MEMBER_NAME_BYTES = 4096;
const memberNameTooLong = (length: number): DebPackageAllowanceFailure =>
  new DebPackageAllowanceFailure(
    "ar_member_name_bytes",
    MAX_AR_MEMBER_NAME_BYTES,
    `ar member name of ${String(length)} bytes exceeds the ${String(MAX_AR_MEMBER_NAME_BYTES)}-byte name limit.`,
  );

/** Resolves a GNU ar `/<offset>` reference against the `//` string table. */
const gnuLongName = (
  stringTable: string,
  index: number,
): string | DebPackageFormatFailure | DebPackageAllowanceFailure => {
  if (index >= stringTable.length)
    return new DebPackageFormatFailure(
      "malformed",
      `GNU ar long name offset ${String(index)} is outside the ${String(stringTable.length)}-byte string table.`,
    );
  const newline = stringTable.indexOf("\n", index);
  let end = newline === -1 ? stringTable.length : newline;
  if (end > index && stringTable[end - 1] === "/") end -= 1;
  if (end - index > MAX_AR_MEMBER_NAME_BYTES)
    return memberNameTooLong(end - index);
  const name = trimField(stringTable.slice(index, end));
  if (name === "")
    return new DebPackageFormatFailure(
      "malformed",
      `GNU ar long name offset ${String(index)} names an empty string-table entry.`,
    );
  return name;
};

const TAR_BLOCK = 512;
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BZ2_MAGIC = Buffer.from("BZh", "ascii");
/** Fixed Zstandard decoder window: 2^27 bytes, matching the ZIP/ELF decoders. */
const ZSTD_WINDOW_LOG_MAX = 27;
const ZSTD_WINDOW_MAX_BYTES = 2 ** ZSTD_WINDOW_LOG_MAX;

/** Limitation wording owned by the parser; tests assert delivery through these. */
export const DEB_PACKAGE_LIMITATIONS = {
  readOnly:
    "This workflow reads the .deb ar container and its control/data tars without installing the package or running maintainer scripts.",
  noSignatures: "Package signatures (debsig/dpkg-sig) are not verified.",
  noScriptText:
    "Maintainer-script text is not returned; only the interpreter line and byte length are observed.",
  md5NoHash:
    "md5sums cross-check compares listed paths to the data inventory and does not hash file contents.",
} as const;

const BASE_LIMITATIONS = [
  DEB_PACKAGE_LIMITATIONS.readOnly,
  DEB_PACKAGE_LIMITATIONS.noSignatures,
  DEB_PACKAGE_LIMITATIONS.noScriptText,
  DEB_PACKAGE_LIMITATIONS.md5NoHash,
] as const;

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    const error = new Error("Debian package inspection was cancelled");
    error.name = "AbortError";
    throw error;
  }
};

const ascii = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("ascii");

/**
 * A fixed-width ar or tar header field: text up to the first NUL, trimmed.
 * A single `indexOf` keeps this linear for any input.
 */
const trimField = (value: string): string => {
  const nul = value.indexOf("\0");
  return (nul === -1 ? value : value.slice(0, nul)).trim();
};

const nonempty = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const UTF8_LENIENT = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A NUL-terminated tar name field as UTF-8. Names keep surrounding spaces
 * and backslashes, which are legal in Unix paths; `undecodable` is set when
 * the bytes are not UTF-8 and the text carries U+FFFD replacements.
 */
const tarText = (
  bytes: Uint8Array,
): { readonly text: string; readonly undecodable: boolean } => {
  const end = bytes.indexOf(0);
  const field = end === -1 ? bytes : bytes.subarray(0, end);
  const strict = decodeUtf8(field);
  return strict === null
    ? { text: UTF8_LENIENT.decode(field), undecodable: true }
    : { text: strict, undecodable: false };
};

const POSIX_USTAR_MAGIC = new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]);

const isPosixUstar = (header: Uint8Array): boolean =>
  looksLike(header.subarray(257, 263), POSIX_USTAR_MAGIC);

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return decodeStrictUtf8(bytes, "preserve");
  } catch {
    return null;
  }
};

const looksLike = (bytes: Uint8Array, magic: Uint8Array): boolean => {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++)
    if (bytes[i] !== magic[i]) return false;
  return true;
};

/** Decimal text such as a control field value; NUL is not a terminator. */
const parseDecimal = (text: string): number | null => {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
};

const parseOctal = (text: string): number | null => {
  const trimmed = trimField(text).replace(/ /gu, "");
  if (trimmed.length === 0) return 0;
  if (!/^[0-7]+$/u.test(trimmed)) return null;
  return Number.parseInt(trimmed, 8);
};

const parseTarNumber = (bytes: Uint8Array): number | null => {
  const first = bytes[0];
  if (first !== undefined && (first & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < bytes.length; i++)
      value = value * 256 + (bytes[i] ?? 0);
    return value;
  }
  return parseOctal(ascii(bytes));
};

const tarType = (flag: number): DebTarEntry["type"] => {
  switch (flag) {
    case 0:
    case 48:
      return "file";
    case 49:
      return "hardlink";
    case 50:
      return "symlink";
    case 51:
      return "character";
    case 52:
      return "block";
    case 53:
      return "directory";
    case 54:
      return "fifo";
    default:
      return "unknown";
  }
};

/** The issue detail for a relationship field with unreadable alternatives. */
export const unreadableRelationshipsDetail = (
  field: string,
  count: number,
  first: string,
): string =>
  `${field} has ${String(count)} unreadable alternative(s); the first is ${JSON.stringify(first)}.`;

/** The limitation for tar entry names or link targets that are not UTF-8. */
export const undecodableTarNamesLimitation = (count: number): string =>
  `${String(count)} tar entry names or link targets are not UTF-8; they are shown with U+FFFD replacements and may not match md5sums.`;

/**
 * GNU long name/link and PAX headers that may precede one tar entry. Real
 * archives use at most a few; a longer run is refused before it costs work.
 */
const MAX_TAR_EXTENSION_HEADERS = 8;
/**
 * Fixed allowance for relationship alternatives across a control file. Each
 * `|` or `,` can become a report object, so a two-byte separator grows into
 * far more report; real packages list at most a few hundred.
 */
const MAX_RELATIONSHIP_ALTERNATIVES = 65_536;

/** The PAX record keys this reader applies to the following entry. */
const PAX_KEYS = [
  "path",
  "linkpath",
  "size",
  "uid",
  "gid",
  "uname",
  "gname",
] as const;

/**
 * PAX text values a global record can repeat into every later row. Numeric
 * keys are parsed to numbers and do not repeat text.
 */
const GLOBAL_PAX_TEXT_KEYS = ["path", "linkpath", "uname", "gname"] as const;

const paxId = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
};

const pad512 = (size: number): number =>
  Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

/** Drop trailing `/` by a backward scan; an unanchored regex retries per slash. */
const trimTrailingSlashes = (name: string): string => {
  let end = name.length;
  while (end > 0 && name.charCodeAt(end - 1) === 0x2f) end -= 1;
  return name.slice(0, end);
};

const logicalTarPath = (name: string): string =>
  trimTrailingSlashes(name.replace(/^(?:\.\/)+/u, ""));

const tarChecksum = (header: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++)
    sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum;
};

const isZeroBlock = (block: Uint8Array): boolean => {
  for (const byte of block) if (byte !== 0) return false;
  return true;
};

type ParsedArMember = DebArMember & { readonly bytes: Uint8Array };

type ArParse = {
  readonly members: ParsedArMember[];
  readonly error?: DebPackageReadFailure;
};

const parseArMembers = (bytes: Uint8Array, maxMembers: number): ArParse => {
  if (
    bytes.length < AR_MAGIC.length ||
    !bytes.subarray(0, AR_MAGIC.length).every((byte, i) => byte === AR_MAGIC[i])
  )
    throw new DebPackageFormatFailure(
      "malformed",
      "File does not begin with Debian ar magic !<arch>\\n.",
    );
  const members: ParsedArMember[] = [];
  let offset = AR_MAGIC.length;
  let stringTable: string | null = null;
  while (offset < bytes.length) {
    if (offset + AR_HEADER > bytes.length) {
      if (isZeroBlock(bytes.subarray(offset))) break;
      return {
        members,
        error: new DebPackageFormatFailure(
          "truncated",
          "ar member header extends past the end of the file.",
        ),
      };
    }
    const header = bytes.subarray(offset, offset + AR_HEADER);
    if (header[58] !== 0x60 || header[59] !== 0x0a)
      return {
        members,
        error: new DebPackageFormatFailure(
          "malformed",
          "ar member header is missing the `\\n terminator.",
        ),
      };
    const rawName = ascii(header.subarray(0, 16));
    const size = parseDecimal(trimField(ascii(header.subarray(48, 58))));
    if (size === null)
      return {
        members,
        error: new DebPackageFormatFailure(
          "malformed",
          "ar member size is not a decimal integer.",
        ),
      };
    let dataStart = offset + AR_HEADER;
    let name = trimField(rawName);
    let dataSize = size;
    if (name.startsWith("#1/")) {
      const nameLength = Number(name.slice(3));
      if (!Number.isInteger(nameLength) || nameLength < 0 || nameLength > size)
        return {
          members,
          error: new DebPackageFormatFailure(
            "malformed",
            "BSD ar long name length is invalid.",
          ),
        };
      if (nameLength > MAX_AR_MEMBER_NAME_BYTES)
        return { members, error: memberNameTooLong(nameLength) };
      if (dataStart + nameLength > bytes.length)
        return {
          members,
          error: new DebPackageFormatFailure(
            "truncated",
            "BSD ar long name extends past the end of the file.",
          ),
        };
      name = trimField(
        ascii(bytes.subarray(dataStart, dataStart + nameLength)),
      );
      dataStart += nameLength;
      dataSize = size - nameLength;
    } else if (name === "//") {
      if (dataStart + size > bytes.length)
        return {
          members,
          error: new DebPackageFormatFailure(
            "truncated",
            "GNU ar string table extends past the end of the file.",
          ),
        };
      // The string table is a physical member: it is kept in the inventory
      // and counted against max_ar_members like any other.
      stringTable = ascii(bytes.subarray(dataStart, dataStart + size));
    } else if (/^\/\d+$/u.test(name)) {
      if (stringTable === null)
        return {
          members,
          error: new DebPackageFormatFailure(
            "malformed",
            "GNU ar long name refers to a missing string table.",
          ),
        };
      const resolved = gnuLongName(stringTable, Number(name.slice(1)));
      if (typeof resolved !== "string") return { members, error: resolved };
      name = resolved;
    } else {
      name = name.replace(/\/$/u, "");
    }
    if (dataStart + dataSize > bytes.length)
      return {
        members,
        error: new DebPackageFormatFailure(
          "truncated",
          `ar member ${name} declares ${String(dataSize)} bytes past the end of the file.`,
        ),
      };
    // Alignment follows the stored member size: a BSD `#1/N` name is part of
    // the member, so the payload length alone can have the wrong parity.
    const memberEnd = offset + AR_HEADER + size;
    const nextOffset = memberEnd + (size % 2);
    if (nextOffset > bytes.length)
      return {
        members,
        error: new DebPackageFormatFailure(
          "truncated",
          `ar member ${name} is missing its padding byte at the end of the file.`,
        ),
      };
    if (members.length >= maxMembers)
      return {
        members,
        error: new DebPackageCapacityFailure(
          "max_ar_members",
          maxMembers,
          `ar member count exceeds the selected max_ar_members budget of ${String(maxMembers)}.`,
        ),
      };
    const payload = bytes.subarray(dataStart, dataStart + dataSize);
    const role = debArMemberRole(name);
    members.push({
      name,
      role,
      size: dataSize,
      offset: dataStart,
      compression:
        role === "control" || role === "data"
          ? debArchiveCompressionFromName(name)
          : null,
      bytes: payload,
    });
    offset = nextOffset;
  }
  return { members };
};

type TarParse = {
  readonly entries: DebTarEntry[];
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly error?: DebPackageReadFailure;
  /** Entry names or link targets that are not UTF-8. */
  readonly undecodableNames: number;
};

type PaxFields = {
  readonly fields: Readonly<Record<string, string>>;
  /** Keys whose value is not UTF-8 and carries U+FFFD replacements. */
  readonly undecodable: ReadonlySet<string>;
  /** Offset of the first record that could not be read, if any. */
  readonly incompleteAt: number | undefined;
};

const parsePax = (bytes: Uint8Array): PaxFields => {
  // Each record is "<length> <key>=<value>\n", where <length> counts bytes,
  // so walk the bytes and decode each record on its own.
  const fields: Record<string, string> = {};
  const undecodable = new Set<string>();
  // A record that cannot be read leaves the extended header's facts unknown.
  const incomplete = (at: number): PaxFields => ({
    fields,
    undecodable,
    incompleteAt: at,
  });
  let index = 0;
  while (index < bytes.length) {
    const space = bytes.indexOf(0x20, index);
    if (space === -1) return incomplete(index);
    const lengthText = Buffer.from(bytes.subarray(index, space)).toString(
      "latin1",
    );
    if (!/^[0-9]+$/u.test(lengthText)) return incomplete(index);
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - index + 1)
      return incomplete(index);
    if (index + length > bytes.length) return incomplete(index);
    const record = tarText(bytes.subarray(space + 1, index + length));
    const eq = record.text.indexOf("=");
    if (eq !== -1) {
      const key = record.text.slice(0, eq);
      fields[key] = record.text.slice(eq + 1).replace(/\n$/u, "");
      if (record.undecodable) undecodable.add(key);
      else undecodable.delete(key);
    }
    index += length;
  }
  return { fields, undecodable, incompleteAt: undefined };
};

const parseTar = (
  bytes: Uint8Array,
  maxEntries: number,
  memberName: string,
  byteBudget: {
    readonly resource: "max_control_bytes" | "max_data_bytes";
    readonly maximum: number;
  },
): TarParse => {
  const entries: DebTarEntry[] = [];
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longname: string | null = null;
  let longnameUndecodable = false;
  let longlinkUndecodable = false;
  let undecodableNames = 0;
  let longlink: string | null = null;
  // Only the PAX keys this reader uses are kept, so a run of headers with
  // fresh keys cannot grow or repeatedly copy an object.
  const pax: Partial<Record<(typeof PAX_KEYS)[number], string>> = {};
  let extensionHeaders = 0;
  const paxUndecodable = new Set<string>();
  // Global (g) records apply to every later entry; per-file (x) records only
  // to the next one, and override global values for it.
  const globalPax: Partial<Record<(typeof PAX_KEYS)[number], string>> = {};
  const globalUndecodable = new Set<string>();
  // Global numeric owners are parsed once per global record, not per entry:
  // a long global value would otherwise be rescanned for every later row.
  let globalUid: number | undefined;
  let globalGid: number | undefined;
  // A global value is stored once but copied into every later row, so each
  // reuse is charged to the member's byte budget alongside its expanded bytes.
  let charged = bytes.length;
  while (offset + TAR_BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) return { entries, files, undecodableNames };
    const stored = parseOctal(ascii(header.subarray(148, 156)));
    const computed = tarChecksum(header);
    if (stored === null || stored !== computed)
      return {
        entries,
        files,
        undecodableNames,
        error: new DebPackageFormatFailure(
          "malformed",
          `tar header checksum failed in ${memberName} at offset ${String(offset)}.`,
        ),
      };
    const typeFlag = header[156] ?? 0;
    const extension =
      typeFlag === 76 ||
      typeFlag === 75 ||
      typeFlag === 120 ||
      typeFlag === 103;
    // A PAX size record overrides the following entry's header size field;
    // reading or skipping by the header field would desynchronize the stream.
    const paxSize = extension ? undefined : pax.size;
    if (paxSize !== undefined && paxId(paxSize) === undefined)
      return {
        entries,
        files,
        undecodableNames,
        error: new DebPackageFormatFailure(
          "malformed",
          `PAX size record is not a decimal byte count in ${memberName} at offset ${String(offset)}.`,
        ),
      };
    const size =
      paxSize === undefined
        ? parseTarNumber(header.subarray(124, 136))
        : (paxId(paxSize) ?? null);
    if (size === null)
      return {
        entries,
        files,
        undecodableNames,
        error: new DebPackageFormatFailure(
          "malformed",
          `tar size field is unreadable in ${memberName} at offset ${String(offset)}.`,
        ),
      };
    const dataStart = offset + TAR_BLOCK;
    if (dataStart + size > bytes.length)
      return {
        entries,
        files,
        undecodableNames,
        error: new DebPackageFormatFailure(
          "truncated",
          `tar member in ${memberName} extends past the end of the archive.`,
        ),
      };
    const payload = bytes.subarray(dataStart, dataStart + size);
    // Only POSIX ustar headers carry a path prefix at 345. GNU headers
    // ("ustar  \0") keep atime, ctime and sparse data there instead.
    const prefix = isPosixUstar(header)
      ? tarText(header.subarray(345, 500))
      : { text: "", undecodable: false };
    const rawName = tarText(header.subarray(0, 100));
    const headerName =
      prefix.text.length > 0 ? `${prefix.text}/${rawName.text}` : rawName.text;
    if (extension) {
      extensionHeaders += 1;
      if (extensionHeaders > MAX_TAR_EXTENSION_HEADERS)
        return {
          entries,
          files,
          undecodableNames,
          error: new DebPackageAllowanceFailure(
            "tar_extension_headers",
            MAX_TAR_EXTENSION_HEADERS,
            `${memberName} has more than ${String(MAX_TAR_EXTENSION_HEADERS)} extension headers before an entry at offset ${String(offset)}.`,
          ),
        };
    }
    if (typeFlag === 76) {
      const decoded = tarText(payload);
      longname = decoded.text;
      longnameUndecodable = decoded.undecodable;
      offset = dataStart + pad512(size);
      continue;
    }
    if (typeFlag === 75) {
      const decoded = tarText(payload);
      longlink = decoded.text;
      longlinkUndecodable = decoded.undecodable;
      offset = dataStart + pad512(size);
      continue;
    }
    if (typeFlag === 120 || typeFlag === 103) {
      const parsed = parsePax(payload);
      if (parsed.incompleteAt !== undefined)
        return {
          entries,
          files,
          undecodableNames,
          error: new DebPackageFormatFailure(
            "malformed",
            `PAX extended header in ${memberName} at offset ${String(offset)} has an unreadable record at byte ${String(parsed.incompleteAt)}.`,
          ),
        };
      const target = typeFlag === 103 ? globalPax : pax;
      const targetUndecodable =
        typeFlag === 103 ? globalUndecodable : paxUndecodable;
      for (const key of PAX_KEYS) {
        const value = parsed.fields[key];
        if (value === undefined) continue;
        // An empty global value deletes the earlier global override, so later
        // entries read their own header fields again.
        if (typeFlag === 103 && value.length === 0) {
          delete target[key];
          targetUndecodable.delete(key);
          continue;
        }
        target[key] = value;
        if (parsed.undecodable.has(key)) targetUndecodable.add(key);
        else targetUndecodable.delete(key);
      }
      if (typeFlag === 103) {
        globalUid = paxId(globalPax.uid);
        globalGid = paxId(globalPax.gid);
      }
      offset = dataStart + pad512(size);
      continue;
    }
    if (entries.length >= maxEntries)
      return {
        entries,
        files,
        undecodableNames,
        error: new DebPackageCapacityFailure(
          memberName.startsWith("control")
            ? "max_control_entries"
            : "max_data_entries",
          maxEntries,
          `tar entry count in ${memberName} exceeds the selected budget of ${String(maxEntries)}.`,
        ),
      };
    for (const key of GLOBAL_PAX_TEXT_KEYS) {
      const inherited = pax[key] === undefined ? globalPax[key] : undefined;
      if (inherited !== undefined) charged += inherited.length;
    }
    if (charged > byteBudget.maximum)
      return {
        entries,
        files,
        undecodableNames,
        error: new DebPackageCapacityFailure(
          byteBudget.resource,
          byteBudget.maximum,
          `global PAX text repeated into ${memberName} entries exceeds the selected ${byteBudget.resource} budget of ${String(byteBudget.maximum)} at offset ${String(offset)}.`,
        ),
      };
    const fileFields = { ...globalPax, ...pax };
    const undecodableField = (key: string) =>
      pax[key as keyof typeof pax] !== undefined
        ? paxUndecodable.has(key)
        : globalUndecodable.has(key);
    const path = logicalTarPath(fileFields.path ?? longname ?? headerName);
    const headerLink = tarText(header.subarray(157, 257));
    const linkText = fileFields.linkpath ?? longlink ?? headerLink.text;
    const link = linkText.length === 0 ? null : linkText;
    const nameUndecodable =
      fileFields.path !== undefined
        ? undecodableField("path")
        : longname === null
          ? rawName.undecodable || prefix.undecodable
          : longnameUndecodable;
    const linkUndecodable =
      fileFields.linkpath !== undefined
        ? undecodableField("linkpath")
        : longlink === null
          ? headerLink.undecodable
          : longlinkUndecodable;
    if (nameUndecodable || linkUndecodable) undecodableNames += 1;
    const mode = parseOctal(ascii(header.subarray(100, 108)));
    // PAX owner records override the fixed fields, which can hold shortened
    // or fallback values.
    const uid =
      (pax.uid === undefined ? globalUid : paxId(pax.uid)) ??
      parseTarNumber(header.subarray(108, 116));
    const gid =
      (pax.gid === undefined ? globalGid : paxId(pax.gid)) ??
      parseTarNumber(header.subarray(116, 124));
    const user = nonempty(
      fileFields.uname ?? trimField(ascii(header.subarray(265, 297))),
    );
    const group = nonempty(
      fileFields.gname ?? trimField(ascii(header.subarray(297, 329))),
    );
    const type = tarType(typeFlag);
    entries.push({
      path: path.length === 0 ? "." : path,
      type,
      mode: (mode ?? 0).toString(8).padStart(4, "0"),
      size,
      uid,
      gid,
      user,
      group,
      link_target: type === "symlink" || type === "hardlink" ? link : null,
    });
    if (type === "file") files.set(path.length === 0 ? "." : path, payload);
    longname = null;
    longlink = null;
    longnameUndecodable = false;
    longlinkUndecodable = false;
    for (const key of PAX_KEYS) delete pax[key];
    extensionHeaders = 0;
    paxUndecodable.clear();
    offset = dataStart + pad512(size);
  }
  // Without an end-of-archive block the stream must stop exactly on a block
  // boundary; a partial header or missing member padding means it was cut off.
  if (offset !== bytes.length)
    return {
      entries,
      files,
      undecodableNames,
      error: new DebPackageFormatFailure(
        "truncated",
        `${memberName} ends inside a tar block at offset ${String(Math.min(offset, bytes.length))}.`,
      ),
    };
  return { entries, files, undecodableNames };
};

const detectCompression = (
  name: string,
  bytes: Uint8Array,
): DebArMember["compression"] => {
  const fromName = debArchiveCompressionFromName(name);
  if (fromName !== "unknown" && fromName !== "none") return fromName;
  if (isGzip(bytes)) return "gzip";
  if (looksLike(bytes, ZSTD_MAGIC)) return "zstd";
  if (looksLike(bytes, XZ_MAGIC)) return "xz";
  if (looksLike(bytes, BZ2_MAGIC)) return "bzip2";
  return fromName === "none" ? "none" : "unknown";
};

const expandArchive = (
  member: ParsedArMember,
  limit: number,
  signal: AbortSignal | undefined,
): Uint8Array => {
  throwIfAborted(signal);
  const compression = detectCompression(member.name, member.bytes);
  const resource =
    member.role === "control" ? "max_control_bytes" : "max_data_bytes";
  const oversize = (expanded: boolean) =>
    new DebPackageCapacityFailure(
      resource,
      limit,
      `${member.name} ${expanded ? "expands past" : "exceeds"} the selected ${resource} budget of ${String(limit)}.`,
    );
  if (compression === "bzip2" || compression === "lzma")
    throw new DebPackageFormatFailure(
      "unsupported",
      `${member.name} is ${compression}-compressed; this reader has no ${compression} decoder.`,
    );
  if (compression === "xz") {
    const decoded = decodeXz(member.bytes, limit);
    if (!decoded.ok) {
      if (decoded.error.kind === "too_large") throw oversize(true);
      if (decoded.error.kind === "unavailable")
        throw new DebPackageFormatFailure(
          "unsupported",
          `${member.name} is xz-compressed; the xz decoder is unavailable on this platform.`,
        );
      throw new DebPackageFormatFailure(
        decoded.error.kind,
        decoded.error.kind === "truncated"
          ? `${member.name} is a truncated xz stream.`
          : `${member.name} is not a readable xz stream.`,
        undefined,
        decoded.error.kind === "malformed"
          ? { cause: decoded.error.cause }
          : undefined,
      );
    }
    return decoded.value;
  }
  if (compression === "gzip") {
    const result = gunzip(member.bytes, limit);
    if (!result.ok)
      throw result.error === "too_large"
        ? oversize(true)
        : new DebPackageFormatFailure(
            "malformed",
            `${member.name} is not a readable gzip stream.`,
          );
    return result.value;
  }
  if (compression === "zstd") {
    try {
      return zstdDecompressSync(member.bytes, {
        maxOutputLength: Math.max(1, limit),
        params: { [constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX },
      });
    } catch (cause: unknown) {
      const code = (cause as { readonly code?: unknown }).code;
      if (code === "ERR_BUFFER_TOO_LARGE") throw oversize(true);
      // A valid frame can request a window above the fixed decoder ceiling;
      // that is a resource refusal, not evidence the stream is damaged.
      if (code === "ZSTD_error_frameParameter_windowTooLarge")
        throw new DebPackageAllowanceFailure(
          "zstd_window_bytes",
          ZSTD_WINDOW_MAX_BYTES,
          `${member.name} requires a Zstandard decoder window above the fixed ${String(ZSTD_WINDOW_MAX_BYTES / 2 ** 20)} MiB allowance; the stream is not necessarily corrupt.`,
          undefined,
          { cause },
        );
      throw new DebPackageFormatFailure(
        "malformed",
        `${member.name} is not a readable Zstandard stream.`,
        undefined,
        { cause },
      );
    }
  }
  if (member.bytes.length > limit) throw oversize(false);
  return member.bytes;
};

const listedFile = (
  files: ReadonlyMap<string, Uint8Array>,
  name: string,
): { present: boolean; count: number | null; text: string | null } => {
  // Control files live at the root of control.tar; a nested file with the
  // same basename is not one of them.
  const bytes = files.get(name);
  if (bytes === undefined) return { present: false, count: null, text: null };
  const text = decodeUtf8(bytes);
  if (text === null) return { present: true, count: null, text: null };
  const lines = text.split(/\n/u).filter((line) => line.trim().length > 0);
  return { present: true, count: lines.length, text };
};

const interpreterLine = (bytes: Uint8Array): string | null => {
  if (bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  // Decode only the `#!` line, so bytes later in the script cannot hide it.
  const newline = bytes.indexOf(0x0a);
  const line = decodeUtf8(
    bytes.subarray(2, newline === -1 ? bytes.length : newline),
  );
  if (line === null) return null;
  const interpreter = line.replace(/\r$/u, "").trim();
  return interpreter.length === 0 ? null : interpreter;
};

const parseControl = (tar: TarParse, issues: DebPackageIssue[]): DebControl => {
  const listed = listedFile(tar.files, "control");
  const fields =
    listed.text === null ? undefined : deb822Paragraphs(listed.text)[0];
  const textField = (name: string): string | null =>
    nonempty(fields?.get(name));
  const versionText = textField("version");
  let version: DebControl["version"] = null;
  if (versionText !== null) {
    const parsed = parseDebianVersion(versionText);
    if (parsed.upstream.length === 0 || parsed.revision === "")
      issues.push({
        kind: "malformed",
        member: "control.tar",
        field: "Version",
        detail: "Version has an empty upstream version or Debian revision.",
        offset: null,
      });
    else version = parsed;
  }
  const installedText = textField("installed-size");
  let installed_size: number | null = null;
  if (installedText !== null) {
    const parsed = parseDecimal(installedText);
    if (parsed === null)
      issues.push({
        kind: "malformed",
        member: "control.tar",
        field: "Installed-Size",
        detail: "Installed-Size is not a non-negative integer.",
        offset: null,
      });
    else installed_size = parsed;
  }
  const essentialText = textField("essential");
  let essential: boolean | null = null;
  if (essentialText !== null) {
    const lowered = essentialText.toLowerCase();
    if (lowered === "yes") essential = true;
    else if (lowered === "no") essential = false;
    else
      issues.push({
        kind: "malformed",
        member: "control.tar",
        field: "Essential",
        detail: "Essential is not yes or no.",
        offset: null,
      });
  }
  const description = textField("description");
  const description_summary =
    description === null ? null : (description.split("\n")[0]?.trim() ?? "");
  // Count alternatives before building any, so the separators alone cannot
  // expand the report past its allowance.
  let alternatives = 0;
  for (const field of DEB_RELATIONSHIP_FIELDS) {
    const raw = fields?.get(
      DEB_CONTROL_RELATIONSHIP_NAMES[field].toLowerCase(),
    );
    if (raw === undefined) continue;
    alternatives += 1;
    for (let index = 0; index < raw.length; index += 1) {
      const code = raw.charCodeAt(index);
      if (code === 0x2c || code === 0x7c) alternatives += 1;
    }
    if (alternatives > MAX_RELATIONSHIP_ALTERNATIVES)
      throw new DebPackageAllowanceFailure(
        "relationship_alternatives",
        MAX_RELATIONSHIP_ALTERNATIVES,
        `control relationship fields declare more than ${String(MAX_RELATIONSHIP_ALTERNATIVES)} alternatives.`,
      );
  }
  const relationships = Object.fromEntries(
    DEB_RELATIONSHIP_FIELDS.map((field) => {
      const raw = fields?.get(
        DEB_CONTROL_RELATIONSHIP_NAMES[field].toLowerCase(),
      );
      if (raw === undefined) return [field, null];
      const parsed = parseDebianRelationshipField(raw);
      if (parsed.firstUnread !== null) {
        const name = DEB_CONTROL_RELATIONSHIP_NAMES[field];
        const first = ellipsisExcerpt(parsed.firstUnread, 120);
        issues.push({
          kind: "malformed",
          member: "control.tar",
          field: name,
          detail: unreadableRelationshipsDetail(
            name,
            parsed.unreadCount,
            first,
          ),
          offset: null,
        });
      }
      return [field, parsed.groups];
    }),
  ) as DebControl["relationships"];
  const conffiles = listedFile(tar.files, "conffiles");
  const md5sums = listedFile(tar.files, "md5sums");
  const scripts = DEB_MAINTAINER_SCRIPTS.flatMap((name) => {
    const bytes = tar.files.get(name);
    return bytes === undefined
      ? []
      : [{ name, interpreter: interpreterLine(bytes), bytes: bytes.length }];
  });
  if (listed.present && listed.text === null)
    issues.push({
      kind: "malformed",
      member: "control.tar",
      field: "control",
      detail: "control is not valid UTF-8.",
      offset: null,
    });
  return {
    package: textField("package"),
    version,
    architecture: textField("architecture"),
    maintainer: textField("maintainer"),
    installed_size,
    section: textField("section"),
    priority: textField("priority"),
    homepage: textField("homepage"),
    description_summary:
      description_summary === "" ? null : description_summary,
    source: textField("source"),
    multi_arch: textField("multi-arch"),
    essential,
    relationships,
    conffiles: { present: conffiles.present, count: conffiles.count },
    md5sums: { present: md5sums.present, count: md5sums.count },
    maintainer_scripts: scripts,
  };
};

const MD5SUM_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  n: "\n",
  r: "\r",
};

/** A GNU md5sum escaped name; undefined when an escape is not one it writes. */
const unescapeMd5Name = (name: string): string | undefined => {
  let unknown = false;
  const text = name.replaceAll(/\\(.?)/gu, (_, next: string) => {
    const value = Object.hasOwn(MD5SUM_ESCAPES, next)
      ? MD5SUM_ESCAPES[next]
      : undefined;
    if (value === undefined) unknown = true;
    return value ?? "";
  });
  return unknown ? undefined : text;
};

const md5Paths = (
  text: string,
): { readonly paths: readonly string[]; readonly unread: number } => {
  const paths: string[] = [];
  let unread = 0;
  for (const raw of text.split(/\n/u)) {
    const line = raw.replace(/\r$/u, "");
    if (line === "") continue;
    // GNU md5sum prefixes a line with a backslash when it escaped the name
    // (backslash, newline or carriage return). The digest is separated from
    // the path by a space and a space or `*`; other spaces stay in the path.
    const escaped = line.startsWith("\\");
    const match = /^[0-9a-f]{32} [ *](.*)$/iu.exec(
      escaped ? line.slice(1) : line,
    );
    const name =
      match?.[1] === undefined
        ? undefined
        : escaped
          ? unescapeMd5Name(match[1])
          : match[1];
    if (name === undefined) unread += 1;
    else paths.push(logicalTarPath(name));
  }
  return { paths, unread };
};

const attachPartial = (cause: unknown, partial: DebPackage): never => {
  if (cause instanceof DebPackageFormatFailure && cause.partial === undefined)
    throw new DebPackageFormatFailure(cause.kind, cause.message, partial, {
      cause,
    });
  if (cause instanceof DebPackageCapacityFailure && cause.partial === undefined)
    throw new DebPackageCapacityFailure(
      cause.resource,
      cause.maximum,
      cause.message,
      partial,
    );
  if (
    cause instanceof DebPackageAllowanceFailure &&
    cause.partial === undefined
  )
    throw new DebPackageAllowanceFailure(
      cause.allowance,
      cause.maximum,
      cause.message,
      partial,
    );
  throw cause;
};

const draftReport = (fields: {
  readonly artifact: DebPackage["artifact"];
  readonly members: readonly DebArMember[];
  readonly extra_member_names: readonly string[];
  readonly format_version: string | null;
  readonly control: DebControl | null;
  readonly data_entries: readonly DebTarEntry[];
  readonly md5sums_cross_check: DebPackage["md5sums_cross_check"];
  readonly issues: readonly DebPackageIssue[];
  readonly control_entries: number;
  readonly examined_control_bytes: number;
  readonly examined_data_bytes: number;
  readonly limitations: readonly string[];
}): DebPackage => ({
  artifact: fields.artifact,
  ar: {
    magic: "!<arch>\n",
    format_version: fields.format_version,
    members: [...fields.members],
    extra_member_names: [...fields.extra_member_names],
  },
  control: fields.control,
  data_entries: [...fields.data_entries],
  md5sums_cross_check: fields.md5sums_cross_check,
  issues: [...fields.issues],
  coverage: {
    status: "partial",
    ar_members: fields.members.length,
    control_entries: fields.control_entries,
    data_entries: fields.data_entries.length,
    examined_control_bytes: fields.examined_control_bytes,
    examined_data_bytes: fields.examined_data_bytes,
  },
  limitations: [...fields.limitations],
});

/** Decode one Debian .deb into typed Evidence facts. */
export const parseDebPackage = (
  bytes: Uint8Array,
  artifact: DebPackage["artifact"],
  input: InspectDebPackageInput,
  signal?: AbortSignal,
): DebPackage => {
  throwIfAborted(signal);
  const parsedAr = parseArMembers(bytes, input.max_ar_members);
  const arMembers = parsedAr.members;
  const members: DebArMember[] = arMembers.map(
    ({ bytes: payload, ...member }) => ({
      ...member,
      compression: detectCompression(member.name, payload),
    }),
  );
  // Only the first debian-binary, control, and data member is read; a later
  // member with the same role is left unread and flagged as extra.
  const seenRoles = new Set<DebArMember["role"]>();
  const repeated_member_names: string[] = [];
  const extra_member_names = members
    .filter((member) => {
      if (member.role === "unknown") return true;
      if (!seenRoles.has(member.role)) {
        seenRoles.add(member.role);
        return false;
      }
      repeated_member_names.push(member.name);
      return true;
    })
    .map((member) => member.name);
  const debianBinary = arMembers.find(
    (member) => member.role === "debian-binary",
  );
  const format_version =
    debianBinary === undefined
      ? null
      : nonempty(decodeUtf8(debianBinary.bytes)?.replace(/\n$/u, "") ?? "");
  const issues: DebPackageIssue[] = [];
  let control: DebControl | null = null;
  let controlTar: TarParse | null = null;
  let dataTar: TarParse | null = null;
  let examined_control_bytes = 0;
  let examined_data_bytes = 0;
  const controlMember = arMembers.find((member) => member.role === "control");
  const dataMember = arMembers.find((member) => member.role === "data");
  const limitations: string[] = [...BASE_LIMITATIONS];
  for (const name of repeated_member_names)
    limitations.push(
      `ar member ${name} repeats an earlier member's role and was not read.`,
    );
  const snapshot = (): DebPackage =>
    draftReport({
      artifact,
      members,
      extra_member_names,
      format_version,
      control,
      data_entries: dataTar?.entries ?? [],
      md5sums_cross_check: null,
      issues,
      control_entries: controlTar?.entries.length ?? 0,
      examined_control_bytes,
      examined_data_bytes,
      limitations,
    });
  if (parsedAr.error !== undefined) attachPartial(parsedAr.error, snapshot());
  try {
    if (controlMember !== undefined) {
      const expanded = expandArchive(
        controlMember,
        input.max_control_bytes,
        signal,
      );
      examined_control_bytes = expanded.length;
      controlTar = parseTar(
        expanded,
        input.max_control_entries,
        controlMember.name,
        { resource: "max_control_bytes", maximum: input.max_control_bytes },
      );
      if (controlTar.entries.length > 0 || controlTar.files.size > 0)
        control = parseControl(controlTar, issues);
      if (controlTar.error !== undefined)
        attachPartial(controlTar.error, snapshot());
    }
    if (dataMember !== undefined) {
      const expanded = expandArchive(dataMember, input.max_data_bytes, signal);
      examined_data_bytes = expanded.length;
      dataTar = parseTar(expanded, input.max_data_entries, dataMember.name, {
        resource: "max_data_bytes",
        maximum: input.max_data_bytes,
      });
      if (dataTar.error !== undefined) attachPartial(dataTar.error, snapshot());
    }
  } catch (cause: unknown) {
    attachPartial(cause, snapshot());
  }
  let md5sums_cross_check: DebPackage["md5sums_cross_check"] = null;
  const md5sumsText =
    control !== null && control.md5sums.present && controlTar !== null
      ? listedFile(controlTar.files, "md5sums").text
      : null;
  if (control !== null && control.md5sums.present && md5sumsText === null)
    limitations.push(
      "md5sums is not readable UTF-8 text; the md5sums cross-check is unknown.",
    );
  else if (md5sumsText !== null && dataTar === null)
    limitations.push(
      "No data.tar inventory was read; the md5sums cross-check is unknown.",
    );
  if (md5sumsText !== null && dataTar !== null) {
    const { paths: listed, unread } = md5Paths(md5sumsText);
    if (unread > 0)
      limitations.push(
        `${String(unread)} md5sums line(s) are not md5sum digest lines and were not compared.`,
      );
    const inventory = new Set(
      dataTar.entries
        .filter((entry) => entry.type === "file" || entry.type === "hardlink")
        .map((entry) => logicalTarPath(entry.path)),
    );
    let present = 0;
    let missing_from_inventory = 0;
    for (const path of listed) {
      if (inventory.has(path)) present += 1;
      else missing_from_inventory += 1;
    }
    let missing_from_md5sums = 0;
    const listedSet = new Set(listed);
    for (const path of inventory)
      if (!listedSet.has(path)) missing_from_md5sums += 1;
    md5sums_cross_check = {
      listed: listed.length,
      present,
      missing_from_inventory,
      missing_from_md5sums,
    };
  }
  for (const tar of [controlTar, dataTar])
    if (tar !== null && tar.undecodableNames > 0)
      limitations.push(undecodableTarNamesLimitation(tar.undecodableNames));
  if (controlMember === undefined)
    limitations.push("No control.tar member was present.");
  if (dataMember === undefined)
    limitations.push("No data.tar member was present.");
  const controlFilePresent =
    controlTar !== null &&
    listedFile(controlTar.files, "control").text !== null;
  if (controlTar !== null && !controlFilePresent)
    limitations.push("control.tar held no control file.");
  if (debianBinary === undefined)
    limitations.push("No debian-binary member was present.");
  if (format_version === null)
    limitations.push("debian-binary format version is unknown.");
  const status =
    issues.length === 0 &&
    extra_member_names.length === 0 &&
    format_version !== null &&
    controlFilePresent &&
    dataMember !== undefined
      ? "complete"
      : "partial";
  return {
    artifact,
    ar: {
      magic: "!<arch>\n",
      format_version,
      members,
      extra_member_names,
    },
    control,
    data_entries: dataTar?.entries ?? [],
    md5sums_cross_check,
    issues,
    coverage: {
      status,
      ar_members: members.length,
      control_entries: controlTar?.entries.length ?? 0,
      data_entries: dataTar?.entries.length ?? 0,
      examined_control_bytes,
      examined_data_bytes,
    },
    limitations,
  };
};
