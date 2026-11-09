/**
 * Canonical ASCII parsers and validators for path-inferred Cargo crates and
 * rustc toolchain version banners. Kept regex-free so scans stay linear.
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

export const isAsciiAlpha = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

export const isAsciiAlnum = (code: number): boolean =>
  isAsciiDigit(code) || isAsciiAlpha(code);

export const isCrateNameByte = (code: number): boolean =>
  isAsciiAlnum(code) || code === 0x2d || code === 0x5f;

export const isRegistryOrGitSlugByte = (code: number): boolean =>
  isCrateNameByte(code) || code === 0x2e;

export const isCargoGitSlugByte = (code: number): boolean =>
  isRegistryOrGitSlugByte(code) ||
  code === 0x2b ||
  code === 0x7e ||
  code === 0x25;

const isSemverIdentByte = (code: number): boolean =>
  isAsciiAlnum(code) || code === 0x2d;

const readSemverCoreNumber = (text: string, start: number): number => {
  let cursor = start;
  while (cursor < text.length && isAsciiDigit(text.charCodeAt(cursor)))
    cursor += 1;
  const digits = cursor - start;
  if (digits < 1 || digits > 20) return -1;
  if (digits > 1 && text.charCodeAt(start) === 0x30) return -1;
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
  if (text.length < 5 || text.length > 128) return false;
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

/**
 * Split `<crate_name>-<semver>` at the first `-` followed by a valid Cargo
 * SemVer so hyphenated crate names and pre-release versions stay unambiguous.
 */
export const splitCargoRegistryCrateSegment = (
  segment: string,
): { readonly name: string; readonly version: string } | null => {
  if (segment.length < 7 || segment.length > 257) return null;
  const first = segment.charCodeAt(0);
  if (!isAsciiAlnum(first) && first !== 0x5f) return null;
  for (let index = 1; index <= segment.length - 6; index += 1) {
    const code = segment.charCodeAt(index);
    if (!isCrateNameByte(code)) return null;
    if (
      code === 0x2d &&
      index <= 128 &&
      isAsciiDigit(segment.charCodeAt(index + 1))
    ) {
      const version = segment.slice(index + 1);
      if (isValidCargoSemver(version))
        return { name: segment.slice(0, index), version };
    }
  }
  return null;
};

/** Validate `<index-host-hash>` in `cargo/registry/src/<index-host-hash>/`. */
export const isValidCargoRegistryIndex = (segment: string): boolean => {
  if (
    segment.length < 1 ||
    segment.length > 128 ||
    segment === "." ||
    segment === ".."
  )
    return false;
  for (let index = 0; index < segment.length; index += 1) {
    if (!isRegistryOrGitSlugByte(segment.charCodeAt(index))) return false;
  }
  return true;
};

/** Validate `<repo_slug>-<16-hex-id>` and `<7..40-hex-rev>` from Cargo git checkouts. */
export const splitCargoGitCheckoutSegments = (
  checkoutDir: string,
  revisionSegment: string,
): {
  readonly name: string;
  readonly checkout_id: string;
  readonly revision: string;
} | null => {
  if (checkoutDir.length < 18 || checkoutDir.length > 145) return null;
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
  if (digits < 1 || digits > 20) return -1;
  if (digits > 1 && bytes[start] === 0x30) return -1;
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
}): number =>
  crate.source_kind === "registry"
    ? 22 +
      (crate.registry_index?.length ?? 0) +
      crate.name.length +
      (crate.version?.length ?? 0)
    : 39 + crate.name.length + (crate.revision?.length ?? 0);
