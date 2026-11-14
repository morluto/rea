/**
 * Canonical linear byte and UTF-8 parsers and validators for path-inferred
 * Cargo crates and rustc toolchain version banners.
 */

export interface ParsedRustcBanner {
  readonly banner: string;
  readonly version: string;
  readonly channel: "stable" | "beta" | "nightly" | "dev";
  readonly commit_hash: string | null;
  readonly commit_date: string | null;
}

export const isAsciiDigit = (code: number): boolean =>
  code >= 0x30 && code <= 0x39;

export const isLowerHex = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);

export const isAsciiHex = (code: number): boolean =>
  isAsciiDigit(code) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

export const isAsciiAlpha = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

export const isAsciiAlnum = (code: number): boolean =>
  isAsciiDigit(code) || isAsciiAlpha(code);

export const isCrateNameByte = (code: number): boolean =>
  isAsciiAlnum(code) || code === 0x2d || code === 0x5f;

export const isRegistryOrGitSlugByte = (code: number): boolean =>
  isCrateNameByte(code) || code === 0x2e;

/**
 * Printable non-space ASCII bytes permitted in unbracketed Cargo registry host
 * or local path-segment identifiers (`url::Url::host_str()` / fallback segment).
 */
export const isCargoRegistryHostByte = (code: number): boolean =>
  code >= 0x21 &&
  code <= 0x7e &&
  code !== 0x22 &&
  code !== 0x23 &&
  code !== 0x2f &&
  code !== 0x3a &&
  code !== 0x3c &&
  code !== 0x3e &&
  code !== 0x3f &&
  code !== 0x40 &&
  code !== 0x5b &&
  code !== 0x5c &&
  code !== 0x5d &&
  code !== 0x5e &&
  code !== 0x60 &&
  code !== 0x7b &&
  code !== 0x7c &&
  code !== 0x7d;

/**
 * Scanner byte class for `<index-host-hash>` in `cargo/registry/src/<index-host-hash>/`,
 * admitting both unbracketed host identifiers and bracketed IPv6 literals (`[::1]`).
 */
export const isCargoRegistryIndexByte = (code: number): boolean =>
  isCargoRegistryHostByte(code) ||
  code === 0x3a ||
  code === 0x5b ||
  code === 0x5d;

/**
 * Cargo derives git checkout directory slugs from the final `url::Url` path
 * segment of `SourceId::canonical_url()`, admitting printable non-space ASCII
 * (`0x21..0x7e`) except path separators (`/`, `\`) and WHATWG URL path
 * delimiters/percent-encoded characters (`"`, `#`, `<`, `>`, `?`, `` ` ``, `{`, `}`).
 */
export const isCargoGitSlugByte = (code: number): boolean =>
  code >= 0x21 &&
  code <= 0x7e &&
  code !== 0x22 &&
  code !== 0x23 &&
  code !== 0x2f &&
  code !== 0x3c &&
  code !== 0x3e &&
  code !== 0x3f &&
  code !== 0x5c &&
  code !== 0x60 &&
  code !== 0x7b &&
  code !== 0x7d;

const isSemverIdentByte = (code: number): boolean =>
  isAsciiAlnum(code) || code === 0x2d;

const U64_MAX_DECIMAL = "18446744073709551615";

export const MAX_CARGO_CRATE_NAME_BYTES = 256;
export const MAX_CARGO_SEMVER_BYTES = 256;
export const MAX_CARGO_REGISTRY_CRATE_DIR_BYTES =
  MAX_CARGO_CRATE_NAME_BYTES + 1 + MAX_CARGO_SEMVER_BYTES;
export const MAX_CARGO_REGISTRY_INDEX_BYTES = 512;
export const MAX_CARGO_GIT_SLUG_BYTES = 1024;
export const MAX_CARGO_GIT_CHECKOUT_DIR_BYTES = MAX_CARGO_GIT_SLUG_BYTES + 17;

const exceedsU64MaxText = (text: string, start: number): boolean => {
  for (let index = 0; index < U64_MAX_DECIMAL.length; index += 1) {
    const digit = text.charCodeAt(start + index);
    const maxDigit = U64_MAX_DECIMAL.charCodeAt(index);
    if (digit !== maxDigit) return digit > maxDigit;
  }
  return false;
};

const exceedsU64MaxBytes = (bytes: Uint8Array, start: number): boolean => {
  for (let index = 0; index < U64_MAX_DECIMAL.length; index += 1) {
    const digit = bytes[start + index] ?? 0;
    const maxDigit = U64_MAX_DECIMAL.charCodeAt(index);
    if (digit !== maxDigit) return digit > maxDigit;
  }
  return false;
};

const readSemverCoreNumber = (text: string, start: number): number => {
  let cursor = start;
  while (cursor < text.length && isAsciiDigit(text.charCodeAt(cursor)))
    cursor += 1;
  const digits = cursor - start;
  if (digits < 1 || digits > U64_MAX_DECIMAL.length) return -1;
  if (digits > 1 && text.charCodeAt(start) === 0x30) return -1;
  if (digits === U64_MAX_DECIMAL.length && exceedsU64MaxText(text, start))
    return -1;
  return cursor;
};

const readDotSeparatedIdentifiers = (
  text: string,
  start: number,
  stopAtPlus: boolean,
): number => {
  if (start >= text.length) return -1;
  let cursor = start;
  let segmentStart = start;
  let segmentLength = 0;
  let segmentDigitsOnly = true;
  const hasLeadingZeroNumericSegment = (): boolean =>
    stopAtPlus &&
    segmentDigitsOnly &&
    segmentLength > 1 &&
    text.charCodeAt(segmentStart) === 0x30;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (isSemverIdentByte(code)) {
      if (!isAsciiDigit(code)) segmentDigitsOnly = false;
      segmentLength += 1;
      cursor += 1;
      continue;
    }
    if (code === 0x2e) {
      if (segmentLength === 0 || hasLeadingZeroNumericSegment()) return -1;
      cursor += 1;
      segmentStart = cursor;
      segmentLength = 0;
      segmentDigitsOnly = true;
      continue;
    }
    if (stopAtPlus && code === 0x2b)
      return segmentLength === 0 || hasLeadingZeroNumericSegment()
        ? -1
        : cursor;
    return -1;
  }
  return segmentLength === 0 || hasLeadingZeroNumericSegment() ? -1 : cursor;
};

/** Linear SemVer 2.0 check matching Cargo package version syntax. */
export const isValidCargoSemver = (text: string): boolean => {
  if (text.length < 5 || text.length > MAX_CARGO_SEMVER_BYTES) return false;
  let cursor = readSemverCoreNumber(text, 0);
  if (cursor < 0 || text.charCodeAt(cursor) !== 0x2e) return false;
  cursor = readSemverCoreNumber(text, cursor + 1);
  if (cursor < 0 || text.charCodeAt(cursor) !== 0x2e) return false;
  cursor = readSemverCoreNumber(text, cursor + 1);
  if (cursor < 0) return false;
  if (cursor === text.length) return true;
  if (text.charCodeAt(cursor) === 0x2d) {
    cursor = readDotSeparatedIdentifiers(text, cursor + 1, true);
    if (cursor < 0) return false;
    if (cursor === text.length) return true;
  }
  if (text.charCodeAt(cursor) === 0x2b) {
    cursor = readDotSeparatedIdentifiers(text, cursor + 1, false);
    return cursor === text.length;
  }
  return false;
};

const UNICODE_XID_START = /^\p{XID_Start}$/u;
const UNICODE_XID_CONTINUE = /^\p{XID_Continue}$/u;

const codePointUtf8Bytes = (codePoint: number): number => {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
};

/** UTF-8 byte length of `text` computed in a single scalar pass. */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (const ch of text) {
    bytes += codePointUtf8Bytes(ch.codePointAt(0) ?? 0);
  }
  return bytes;
};

const isCargoCrateStartChar = (ch: string, codePoint: number): boolean => {
  if (codePoint <= 0x7f) return isAsciiAlpha(codePoint) || codePoint === 0x5f;
  return codePoint <= 0xd7ff || codePoint >= 0xe000
    ? UNICODE_XID_START.test(ch)
    : false;
};

const isCargoCrateContinueChar = (ch: string, codePoint: number): boolean => {
  if (codePoint <= 0x7f) return isCrateNameByte(codePoint);
  return codePoint <= 0xd7ff || codePoint >= 0xe000
    ? UNICODE_XID_CONTINUE.test(ch)
    : false;
};

const parseCargoRegistryCrateSegment = (
  segment: string,
  enforceByteBounds: boolean,
): { readonly name: string; readonly version: string } | null => {
  if (segment.length < 7) return null;
  let utf16Index = 0;
  let nameUtf8Bytes = 0;
  for (const ch of segment) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (utf16Index === 0) {
      if (!isCargoCrateStartChar(ch, codePoint)) return null;
    } else {
      if (!isCargoCrateContinueChar(ch, codePoint)) return null;
      if (
        codePoint === 0x2d &&
        (!enforceByteBounds || nameUtf8Bytes <= MAX_CARGO_CRATE_NAME_BYTES) &&
        utf16Index + 1 < segment.length &&
        isAsciiDigit(segment.charCodeAt(utf16Index + 1))
      ) {
        const version = segment.slice(utf16Index + 1);
        if (isValidCargoSemver(version)) {
          if (
            enforceByteBounds &&
            nameUtf8Bytes + 1 + version.length >
              MAX_CARGO_REGISTRY_CRATE_DIR_BYTES
          )
            return null;
          return { name: segment.slice(0, utf16Index), version };
        }
      }
    }
    nameUtf8Bytes += codePointUtf8Bytes(codePoint);
    if (enforceByteBounds && nameUtf8Bytes > MAX_CARGO_CRATE_NAME_BYTES)
      return null;
    utf16Index += ch.length;
    if (utf16Index > segment.length - 5) break;
  }
  return null;
};

/**
 * Split `<crate_name>-<semver>` at the first `-` followed by a valid Cargo
 * SemVer so hyphenated or Unicode XID crate names and pre-release versions
 * stay unambiguous.
 */
export const splitCargoRegistryCrateSegment = (
  segment: string,
): { readonly name: string; readonly version: string } | null =>
  parseCargoRegistryCrateSegment(segment, true);

/**
 * Grammar check for `<crate_name>-<semver>` without enforcing the retained
 * crate-name byte cap (used to distinguish over-cap crates from noise).
 */
export const hasUnboundedCargoRegistryCrateShape = (segment: string): boolean =>
  parseCargoRegistryCrateSegment(segment, false) !== null;

const isValidIpv4Tail = (text: string, start: number): boolean => {
  let cursor = start;
  for (let part = 0; part < 4; part += 1) {
    if (part > 0) {
      if (cursor >= text.length || text.charCodeAt(cursor) !== 0x2e)
        return false;
      cursor += 1;
    }
    const octetStart = cursor;
    let value = 0;
    while (
      cursor < text.length &&
      cursor - octetStart < 3 &&
      isAsciiDigit(text.charCodeAt(cursor))
    ) {
      value = value * 10 + (text.charCodeAt(cursor) - 0x30);
      cursor += 1;
    }
    const digits = cursor - octetStart;
    if (digits === 0 || value > 255) return false;
    if (digits > 1 && text.charCodeAt(octetStart) === 0x30) return false;
  }
  return cursor === text.length;
};

/** Linear RFC 4291 / WHATWG URL IPv6 literal check (without surrounding brackets). */
export const isValidIpv6Literal = (text: string): boolean => {
  if (text.length < 2 || text.length > 45) return false;
  let cursor = 0;
  let groups = 0;
  let hasCompression = false;
  if (text.charCodeAt(0) === 0x3a) {
    if (text.charCodeAt(1) !== 0x3a) return false;
    hasCompression = true;
    cursor = 2;
    if (cursor === text.length) return true;
  }
  while (cursor < text.length) {
    const groupStart = cursor;
    while (cursor < text.length && isAsciiHex(text.charCodeAt(cursor)))
      cursor += 1;
    if (cursor < text.length && text.charCodeAt(cursor) === 0x2e) {
      if (!isValidIpv4Tail(text, groupStart)) return false;
      groups += 2;
      return hasCompression ? groups <= 7 : groups === 8;
    }
    const groupDigits = cursor - groupStart;
    if (groupDigits < 1 || groupDigits > 4) return false;
    groups += 1;
    if (cursor === text.length) break;
    if (text.charCodeAt(cursor) !== 0x3a) return false;
    cursor += 1;
    if (cursor === text.length) return false;
    if (text.charCodeAt(cursor) === 0x3a) {
      if (hasCompression) return false;
      hasCompression = true;
      cursor += 1;
      if (cursor === text.length) break;
    }
  }
  return hasCompression ? groups <= 7 : groups === 8;
};

const hasTrailingCargoHashSuffix = (segment: string): boolean => {
  if (segment.length < 18 || segment.charCodeAt(segment.length - 17) !== 0x2d)
    return false;
  for (let index = segment.length - 16; index < segment.length; index += 1) {
    if (!isLowerHex(segment.charCodeAt(index))) return false;
  }
  return true;
};

/**
 * Validate Cargo's `<ident>[-<16-lower-hex>]` registry directory grammar without
 * imposing the retained byte cap (reused for over-cap truncation classification).
 */
export const isValidCargoRegistryHostComponent = (segment: string): boolean => {
  if (segment.length === 0 || segment === "." || segment === "..") return false;
  const host = hasTrailingCargoHashSuffix(segment)
    ? segment.slice(0, segment.length - 17)
    : segment;
  if (host.length === 0 || host === "." || host === "..") return false;
  if (host.charCodeAt(0) === 0x5b) {
    return (
      host.charCodeAt(host.length - 1) === 0x5d &&
      isValidIpv6Literal(host.slice(1, -1))
    );
  }
  for (let index = 0; index < host.length; index += 1) {
    const code = host.charCodeAt(index);
    if (!isCargoRegistryHostByte(code)) return false;
    if (
      code === 0x25 &&
      (index + 2 >= host.length ||
        !isAsciiHex(host.charCodeAt(index + 1)) ||
        !isAsciiHex(host.charCodeAt(index + 2)))
    )
      return false;
  }
  return true;
};

/** Validate `<index-host-hash>` in `cargo/registry/src/<index-host-hash>/`. */
export const isValidCargoRegistryIndex = (segment: string): boolean =>
  segment.length >= 1 &&
  segment.length <= MAX_CARGO_REGISTRY_INDEX_BYTES &&
  isValidCargoRegistryHostComponent(segment);

/** Validate `<repo_slug>-<16-hex-id>` and `<7..40-hex-rev>` from Cargo git checkouts. */
export const splitCargoGitCheckoutSegments = (
  checkoutDir: string,
  revisionSegment: string,
): {
  readonly name: string;
  readonly checkout_id: string;
  readonly revision: string;
} | null => {
  if (
    checkoutDir.length < 18 ||
    checkoutDir.length > MAX_CARGO_GIT_CHECKOUT_DIR_BYTES
  )
    return null;
  const separatorIndex = checkoutDir.length - 17;
  if (checkoutDir.charCodeAt(separatorIndex) !== 0x2d) return null;
  for (let index = separatorIndex + 1; index < checkoutDir.length; index += 1) {
    if (!isLowerHex(checkoutDir.charCodeAt(index))) return null;
  }
  const name = checkoutDir.slice(0, separatorIndex);
  if (name === "." || name === "..") return null;
  for (let index = 0; index < name.length; index += 1) {
    if (!isCargoGitSlugByte(name.charCodeAt(index))) return null;
  }
  if (revisionSegment.length < 7 || revisionSegment.length > 40) return null;
  for (let index = 0; index < revisionSegment.length; index += 1) {
    if (!isLowerHex(revisionSegment.charCodeAt(index))) return null;
  }
  return {
    name,
    checkout_id: checkoutDir.slice(separatorIndex + 1),
    revision: revisionSegment,
  };
};

const matchesAscii = (
  bytes: Uint8Array,
  offset: number,
  literal: string,
): boolean => {
  if (offset + literal.length > bytes.length) return false;
  for (let index = 0; index < literal.length; index += 1) {
    if (bytes[offset + index] !== literal.charCodeAt(index)) return false;
  }
  return true;
};

const asciiSlice = (bytes: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let index = start; index < end; index += 1)
    out += String.fromCharCode(bytes[index] ?? 0);
  return out;
};

const readByteSemverNumber = (bytes: Uint8Array, start: number): number => {
  let cursor = start;
  while (cursor < bytes.length && isAsciiDigit(bytes[cursor] ?? 0)) cursor += 1;
  const digits = cursor - start;
  if (digits < 1 || digits > U64_MAX_DECIMAL.length) return -1;
  if (digits > 1 && bytes[start] === 0x30) return -1;
  if (digits === U64_MAX_DECIMAL.length && exceedsU64MaxBytes(bytes, start))
    return -1;
  return cursor;
};

const parseTwoDigitsInRange = (
  bytes: Uint8Array,
  offset: number,
  min: number,
  max: number,
): boolean => {
  const tens = bytes[offset] ?? 0;
  const ones = bytes[offset + 1] ?? 0;
  if (!isAsciiDigit(tens) || !isAsciiDigit(ones)) return false;
  const value = (tens - 0x30) * 10 + (ones - 0x30);
  return value >= min && value <= max;
};

const parseCommitAndDateSuffix = (
  bytes: Uint8Array,
  start: number,
): {
  readonly endOffset: number;
  readonly commitHash: string;
  readonly commitDate: string;
} | null => {
  let cursor = start;
  while (
    cursor < bytes.length &&
    cursor - start < 40 &&
    isLowerHex(bytes[cursor] ?? 0)
  )
    cursor += 1;
  const hashLength = cursor - start;
  if (
    hashLength < 7 ||
    (cursor < bytes.length && isLowerHex(bytes[cursor] ?? 0))
  )
    return null;
  if (cursor + 12 > bytes.length || bytes[cursor] !== 0x20) return null;
  const dateStart = cursor + 1;
  for (let index = 0; index < 4; index += 1) {
    if (!isAsciiDigit(bytes[dateStart + index] ?? 0)) return null;
  }
  if (
    bytes[dateStart + 4] !== 0x2d ||
    !parseTwoDigitsInRange(bytes, dateStart + 5, 1, 12) ||
    bytes[dateStart + 7] !== 0x2d ||
    !parseTwoDigitsInRange(bytes, dateStart + 8, 1, 31) ||
    bytes[dateStart + 10] !== 0x29
  )
    return null;
  return {
    endOffset: dateStart + 11,
    commitHash: asciiSlice(bytes, start, cursor),
    commitDate: asciiSlice(bytes, dateStart, dateStart + 10),
  };
};

const MAX_RUSTC_BANNER_VERSION_BYTES = 96;
const MAX_RUSTC_BANNER_BYTES = 160;
const MAX_RUSTC_COMMIT_SUFFIX_BYTES = 54;

const hasInvalidBannerTerminator = (
  bytes: Uint8Array,
  cursor: number,
  truncatedEnd: boolean,
): boolean => {
  if (truncatedEnd && cursor >= bytes.length) return true;
  if (cursor >= bytes.length) return false;
  const trailing = bytes[cursor] ?? 0;
  if (isAsciiAlnum(trailing) || trailing === 0x5f || trailing === 0x2b)
    return true;
  if (trailing === 0x2d) return truncatedEnd && cursor + 8 >= bytes.length;
  if (trailing === 0x2e) {
    return truncatedEnd
      ? cursor + 1 >= bytes.length || isAsciiAlnum(bytes[cursor + 1] ?? 0)
      : cursor + 1 < bytes.length && isAsciiAlnum(bytes[cursor + 1] ?? 0);
  }
  return false;
};

const readRustcChannelSuffix = (
  bytes: Uint8Array,
  versionStart: number,
  hyphenOffset: number,
  truncatedEnd: boolean,
): {
  readonly channel: ParsedRustcBanner["channel"];
  readonly endOffset: number;
} | null => {
  let channel: ParsedRustcBanner["channel"];
  let cursor = hyphenOffset;
  if (matchesAscii(bytes, cursor + 1, "nightly")) {
    channel = "nightly";
    cursor += 8;
  } else if (matchesAscii(bytes, cursor + 1, "beta")) {
    channel = "beta";
    cursor += 5;
  } else if (matchesAscii(bytes, cursor + 1, "dev")) {
    channel = "dev";
    cursor += 4;
  } else {
    return null;
  }
  while (
    cursor < bytes.length &&
    cursor - versionStart <= MAX_RUSTC_BANNER_VERSION_BYTES
  ) {
    const byte = bytes[cursor] ?? 0;
    if (isAsciiAlnum(byte)) {
      cursor += 1;
      continue;
    }
    if (
      (byte === 0x2e || byte === 0x2d) &&
      cursor + 1 < bytes.length &&
      isAsciiAlnum(bytes[cursor + 1] ?? 0)
    ) {
      cursor += 1;
      continue;
    }
    break;
  }
  if (cursor - versionStart > MAX_RUSTC_BANNER_VERSION_BYTES) return null;
  const lastByte = bytes[cursor - 1] ?? 0;
  if (lastByte === 0x2e || lastByte === 0x2d) return null;
  const trailing = cursor < bytes.length ? (bytes[cursor] ?? 0) : 0;
  if (
    trailing === 0x2d ||
    hasInvalidBannerTerminator(bytes, cursor, truncatedEnd)
  )
    return null;
  return { channel, endOffset: cursor };
};

/**
 * Parse a `rustc [version ]<MAJOR.MINOR.PATCH>[-channel][ (<hex> <YYYY-MM-DD>)]`
 * banner starting at `start` in `bytes`.
 */
export const parseRustcVersionBannerAt = (
  bytes: Uint8Array,
  start: number,
  truncatedEnd = false,
): ParsedRustcBanner | null => {
  if (!matchesAscii(bytes, start, "rustc ")) return null;
  if (start > 0 && isCrateNameByte(bytes[start - 1] ?? 0)) return null;
  let cursor = start + 6;
  if (matchesAscii(bytes, cursor, "version ")) cursor += 8;

  const versionStart = cursor;
  cursor = readByteSemverNumber(bytes, cursor);
  if (cursor < 0 || bytes[cursor] !== 0x2e) return null;
  cursor = readByteSemverNumber(bytes, cursor + 1);
  if (cursor < 0 || bytes[cursor] !== 0x2e) return null;
  cursor = readByteSemverNumber(bytes, cursor + 1);
  if (cursor < 0) return null;

  let channel: ParsedRustcBanner["channel"] = "stable";
  if (cursor < bytes.length && bytes[cursor] === 0x2d) {
    const parsedChannel = readRustcChannelSuffix(
      bytes,
      versionStart,
      cursor,
      truncatedEnd,
    );
    if (parsedChannel === null) return null;
    channel = parsedChannel.channel;
    cursor = parsedChannel.endOffset;
  } else if (hasInvalidBannerTerminator(bytes, cursor, truncatedEnd)) {
    return null;
  }

  const versionEnd = cursor;
  if (
    versionEnd - start > MAX_RUSTC_BANNER_BYTES ||
    versionEnd - versionStart > MAX_RUSTC_BANNER_VERSION_BYTES
  )
    return null;
  const version = asciiSlice(bytes, versionStart, versionEnd);

  if (cursor < bytes.length && bytes[cursor] === 0x20) {
    if (truncatedEnd && cursor + 1 >= bytes.length) return null;
    if (cursor + 1 < bytes.length && bytes[cursor + 1] === 0x28) {
      const suffix =
        cursor + 2 < bytes.length
          ? parseCommitAndDateSuffix(bytes, cursor + 2)
          : null;
      if (suffix !== null) {
        if (suffix.endOffset - start > MAX_RUSTC_BANNER_BYTES) return null;
        return {
          banner: asciiSlice(bytes, start, suffix.endOffset),
          version,
          channel,
          commit_hash: suffix.commitHash,
          commit_date: suffix.commitDate,
        };
      }
      if (truncatedEnd && bytes.length - cursor < MAX_RUSTC_COMMIT_SUFFIX_BYTES)
        return null;
    }
  }
  return {
    banner: asciiSlice(bytes, start, versionEnd),
    version,
    channel,
    commit_hash: null,
    commit_date: null,
  };
};

/** Exact banner parser used by schema validation on retained reports. */
export const parseExactRustcVersionBanner = (
  banner: string,
): ParsedRustcBanner | null => {
  if (banner.length < 11 || banner.length > 160) return null;
  const bytes = new Uint8Array(banner.length);
  for (let index = 0; index < banner.length; index += 1) {
    const code = banner.charCodeAt(index);
    if (code > 0x7f) return null;
    bytes[index] = code;
  }
  const parsed = parseRustcVersionBannerAt(bytes, 0);
  return parsed !== null && parsed.banner.length === banner.length
    ? parsed
    : null;
};

/** Minimum matched byte span starting at `first_file_offset` for range checks. */
export const minimumInferredCrateMatchBytes = (crate: {
  readonly name: string;
  readonly version: string | null;
  readonly source_kind: "registry" | "git";
  readonly registry_index: string | null;
  readonly revision: string | null;
}): number => {
  const nameBytes = utf8ByteLength(crate.name);
  return crate.source_kind === "registry"
    ? 22 +
        (crate.registry_index?.length ?? 0) +
        nameBytes +
        (crate.version?.length ?? 0)
    : 39 + nameBytes + (crate.revision?.length ?? 0);
};
