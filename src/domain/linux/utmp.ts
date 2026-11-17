import { BinaryReader } from "../binaryContainer.js";
import { ok, type Result } from "../result.js";
import { decodeStrictUtf8, isStrictUtf8 } from "../strictUtf8.js";

/**
 * Linux login-accounting records: `utmp`, `wtmp` and `btmp`.
 *
 * glibc's `struct utmp` does not have one layout. `ut_session` and `ut_tv` are
 * 32-bit where the ABI keeps 64-bit and 32-bit processes on the same files
 * (`bits/utmp.h` under `__WORDSIZE_TIME64_COMPAT32`) and `long` where it does
 * not. Read from glibc's own headers: `sysdeps/x86/bits/wordsize.h` defines that
 * macro as 1 and `sysdeps/aarch64/bits/wordsize.h` as 0, so an x86-64 record is
 * 384 bytes and an aarch64 record is 400.
 *
 * Record length narrows the layout but never names the byte order, and a length
 * that is a multiple of both layouts narrows nothing, so the caller states the
 * profile it expects and an ambiguous file is reported instead of decoded.
 */

/** Fixed-width string sizes from glibc `bits/utmp.h`. */
const LINE_BYTES = 32;
const ID_BYTES = 4;
const USER_BYTES = 32;
const HOST_BYTES = 256;

/** Offsets both layouts share; they diverge only in the session and time fields. */
const TYPE_OFFSET = 0;
const PID_OFFSET = 4;
const LINE_OFFSET = 8;
const ID_OFFSET = LINE_OFFSET + LINE_BYTES;
const USER_OFFSET = ID_OFFSET + ID_BYTES;
const HOST_OFFSET = USER_OFFSET + USER_BYTES;
const EXIT_TERMINATION_OFFSET = HOST_OFFSET + HOST_BYTES;
const EXIT_CODE_OFFSET = EXIT_TERMINATION_OFFSET + 2;
const SESSION_OFFSET = EXIT_CODE_OFFSET + 2;
const ADDRESS_V6_FIELDS = 4;

export const UTMP_FORMAT = "utmp";

export type UtmpSource = "utmp" | "wtmp" | "btmp";

/** `ut_type` values from glibc `bits/utmp.h`. */
export const UTMP_TYPES = {
  EMPTY: 0,
  RUN_LVL: 1,
  BOOT_TIME: 2,
  NEW_TIME: 3,
  OLD_TIME: 4,
  INIT_PROCESS: 5,
  LOGIN_PROCESS: 6,
  USER_PROCESS: 7,
  DEAD_PROCESS: 8,
  ACCOUNTING: 9,
} as const;

const UTMP_TYPE_NAMES = new Map<number, string>(
  Object.entries(UTMP_TYPES).map(([name, value]) => [value, name]),
);

export interface UtmpFormatProfile {
  readonly name: "linux-x86-64" | "linux-aarch64" | "linux-aarch64-be";
  readonly recordBytes: number;
  readonly byteOrder: "little" | "big";
  readonly sessionBytes: 4 | 8;
  readonly timeBytes: 4 | 8;
}

/**
 * Supported layouts.
 *
 * `linux-x86-64` is the `__WORDSIZE_TIME64_COMPAT32` layout. `linux-aarch64` and
 * `linux-aarch64-be` are the `long`-typed layout, which glibc's aarch64 port
 * carries in both byte orders.
 */
export const UTMP_FORMAT_PROFILES: readonly UtmpFormatProfile[] = [
  {
    name: "linux-x86-64",
    recordBytes: 384,
    byteOrder: "little",
    sessionBytes: 4,
    timeBytes: 4,
  },
  {
    name: "linux-aarch64",
    recordBytes: 400,
    byteOrder: "little",
    sessionBytes: 8,
    timeBytes: 8,
  },
  {
    name: "linux-aarch64-be",
    recordBytes: 400,
    byteOrder: "big",
    sessionBytes: 8,
    timeBytes: 8,
  },
];

export interface UtmpRecord {
  /** Byte offset of this record from the start of the supplied file. */
  readonly fileOffset: number;
  readonly type: number;
  /** Name of `type` when glibc defines one, so an unknown value stays readable. */
  readonly typeName: string | null;
  readonly pid: number;
  readonly line: string;
  readonly id: string;
  readonly user: string;
  readonly host: string;
  readonly exitTermination: number;
  readonly exitCode: number;
  readonly session: number;
  readonly timestampSeconds: number;
  readonly timestampMicroseconds: number;
  /** `ut_addr_v6` as four signed 32-bit words, in the record's own encoding. */
  readonly addressV6: readonly number[];
  /** Fixed-width fields that carried no terminator or were not well-formed UTF-8. */
  readonly undecodedFields: readonly string[];
}

export type UtmpIssue =
  | {
      readonly kind: "ambiguous_format";
      readonly candidates: readonly string[];
    }
  | {
      readonly kind: "truncated_trailing_bytes";
      readonly fileOffset: number;
      readonly bytes: number;
    }
  | {
      readonly kind: "unknown_type";
      readonly fileOffset: number;
      readonly type: number;
    }
  | {
      readonly kind: "undecoded_field";
      readonly fileOffset: number;
      readonly field: string;
    };

export interface UtmpParseResult {
  /** `null` only for an empty file, which carries no layout facts of its own. */
  readonly profile: UtmpFormatProfile | null;
  readonly source: UtmpSource;
  readonly records: readonly UtmpRecord[];
  readonly issues: readonly UtmpIssue[];
}

export type UtmpSelection =
  | { readonly profile: UtmpFormatProfile }
  | { readonly ambiguous: readonly UtmpFormatProfile[] };

/**
 * The profiles a file of this length could hold.
 *
 * A length that is an exact multiple of more than one candidate is ambiguous: the
 * bytes cannot say which ABI wrote them, and the fields then decode differently.
 */
export const utmpProfileCandidates = (
  fileBytes: number,
): readonly UtmpFormatProfile[] =>
  fileBytes === 0
    ? UTMP_FORMAT_PROFILES
    : UTMP_FORMAT_PROFILES.filter(
        (profile) => fileBytes % profile.recordBytes === 0,
      );

export const selectUtmpProfile = (
  fileBytes: number,
  requested?: UtmpFormatProfile,
): UtmpSelection => {
  if (requested !== undefined) return { profile: requested };
  const candidates = utmpProfileCandidates(fileBytes);
  if (candidates.length === 1) return { profile: candidates[0]! };
  return { ambiguous: candidates };
};

interface FieldLayout {
  readonly sessionOffset: number;
  readonly secondsOffset: number;
  readonly microsecondsOffset: number;
  readonly addressOffset: number;
}

/** Where the tail fields sit once `ut_session` and `ut_tv` take their ABI width. */
export const utmpFieldLayout = (profile: UtmpFormatProfile): FieldLayout => {
  const secondsOffset = SESSION_OFFSET + profile.sessionBytes;
  const microsecondsOffset = secondsOffset + profile.timeBytes;
  return {
    sessionOffset: SESSION_OFFSET,
    secondsOffset,
    microsecondsOffset,
    addressOffset: microsecondsOffset + profile.timeBytes,
  };
};

/** Reinterpret an unsigned read as the signed field the record declares. */
const signed = (value: number | bigint, bits: 32 | 64): number =>
  Number(BigInt.asIntN(bits, BigInt(value)));

interface DecodedField {
  readonly text: string;
  readonly decoded: boolean;
}

const decodeFixedWidth = (
  bytes: Buffer,
  base: number,
  offset: number,
  width: number,
): DecodedField => {
  const raw = bytes.subarray(base + offset, base + offset + width);
  const end = raw.indexOf(0);
  const used = end === -1 ? raw : raw.subarray(0, end);
  // A field without a terminator still reads, but it is not a well-formed
  // fixed-width string, so the record says so instead of hiding the shape.
  if (!isStrictUtf8(used))
    return { text: decodeStrictUtf8(used, "preserve"), decoded: false };
  return { text: decodeStrictUtf8(used, "preserve"), decoded: end !== -1 };
};

/**
 * Parse one login-accounting file under a chosen layout.
 *
 * Records decode independently, so a truncated tail or an unknown type keeps the
 * records before it inspectable instead of failing the whole file.
 */
export const parseUtmpFile = (
  input: Uint8Array,
  options: {
    readonly source: UtmpSource;
    readonly profile?: UtmpFormatProfile;
  },
): Result<UtmpParseResult, readonly UtmpIssue[]> => {
  const issues: UtmpIssue[] = [];
  if (input.byteLength === 0)
    return ok({
      profile: options.profile ?? null,
      source: options.source,
      records: [],
      issues,
    });

  const selection = selectUtmpProfile(input.byteLength, options.profile);
  if ("ambiguous" in selection) {
    issues.push({
      kind: "ambiguous_format",
      candidates: selection.ambiguous.map((candidate) => candidate.name),
    });
    return { ok: false, error: issues };
  }

  const profile = selection.profile;
  const little = profile.byteOrder === "little";
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reader = new BinaryReader(bytes, little, UTMP_FORMAT);
  const layout = utmpFieldLayout(profile);
  const whole = Math.floor(input.byteLength / profile.recordBytes);
  const records: UtmpRecord[] = [];

  for (let index = 0; index < whole; index += 1) {
    const base = index * profile.recordBytes;
    const line = decodeFixedWidth(bytes, base, LINE_OFFSET, LINE_BYTES);
    const id = decodeFixedWidth(bytes, base, ID_OFFSET, ID_BYTES);
    const user = decodeFixedWidth(bytes, base, USER_OFFSET, USER_BYTES);
    const host = decodeFixedWidth(bytes, base, HOST_OFFSET, HOST_BYTES);
    const fields = [
      ["line", line],
      ["id", id],
      ["user", user],
      ["host", host],
    ] as const;
    for (const [field, decoded] of fields) {
      if (decoded.decoded) continue;
      issues.push({ kind: "undecoded_field", fileOffset: base, field });
    }
    const type = signed(reader.u16(base + TYPE_OFFSET), 32);
    const typeName = UTMP_TYPE_NAMES.get(type) ?? null;
    if (typeName === null)
      issues.push({ kind: "unknown_type", fileOffset: base, type });
    records.push({
      fileOffset: base,
      type,
      typeName,
      pid: signed(reader.u32(base + PID_OFFSET), 32),
      line: line.text,
      id: id.text,
      user: user.text,
      host: host.text,
      exitTermination: signed(reader.u16(base + EXIT_TERMINATION_OFFSET), 32),
      exitCode: signed(reader.u16(base + EXIT_CODE_OFFSET), 32),
      session: signed(
        reader.word(
          base + layout.sessionOffset,
          profile.sessionBytes === 4 ? 32 : 64,
        ),
        profile.sessionBytes === 4 ? 32 : 64,
      ),
      timestampSeconds: Number(
        reader.word(
          base + layout.secondsOffset,
          profile.timeBytes === 4 ? 32 : 64,
        ),
      ),
      timestampMicroseconds: signed(
        reader.word(
          base + layout.microsecondsOffset,
          profile.timeBytes === 4 ? 32 : 64,
        ),
        profile.timeBytes === 4 ? 32 : 64,
      ),
      addressV6: Array.from({ length: ADDRESS_V6_FIELDS }, (_, slot) =>
        signed(reader.u32(base + layout.addressOffset + slot * 4), 32),
      ),
      undecodedFields: fields
        .filter(([, decoded]) => !decoded.decoded)
        .map(([field]) => field),
    });
  }

  const remainder = input.byteLength - whole * profile.recordBytes;
  if (remainder > 0)
    issues.push({
      kind: "truncated_trailing_bytes",
      fileOffset: whole * profile.recordBytes,
      bytes: remainder,
    });

  return ok({ profile, source: options.source, records, issues });
};
