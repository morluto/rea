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
 * Record length cannot establish the layout at all, and not only because a length
 * can be a multiple of several record sizes: a truncated tail lets a larger record
 * explain any shorter length, so 384 bytes is one x86 record and also an aarch64
 * record missing its last 16 bytes. The caller states the profile it expects, and an
 * ambiguous file reports every profile instead of decoding.
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
  readonly name:
    | "glibc-time32"
    | "glibc-time32-be"
    | "glibc-time64"
    | "glibc-time64-be"
    | "musl-time64"
    | "musl-time64-be";
  readonly recordBytes: number;
  readonly byteOrder: "little" | "big";
  readonly sessionBytes: 4 | 8;
  /**
   * Padding that keeps the following `timeval` aligned when `ut_session` is
   * narrower than it. musl names it `__ut_pad2` and, on a big-endian host, puts
   * it *before* the session id so the pair stays in the host's own order.
   */
  readonly sessionPadBytes: 0 | 4;
  readonly sessionPadBefore: boolean;
  readonly timeBytes: 4 | 8;
  /** glibc declares `ut_addr_v6` as `int32_t`, musl as `unsigned`. */
  readonly addressSigned: boolean;
}

/**
 * Supported layouts.
 *
 * The `-time32` pair is the `__WORDSIZE_TIME64_COMPAT32` shape glibc carries on
 * x86-64 and, byte-swapped, on the big-endian targets that define the macro
 * (`s390x`, big-endian `ppc64`). The `-time64` family is the `long`-typed shape,
 * which glibc's aarch64 port carries in both byte orders.
 */
export const UTMP_FORMAT_PROFILES: readonly UtmpFormatProfile[] = [
  {
    name: "glibc-time32",
    recordBytes: 384,
    byteOrder: "little",
    sessionBytes: 4,
    sessionPadBytes: 0,
    sessionPadBefore: false,
    timeBytes: 4,
    addressSigned: true,
  },
  {
    name: "glibc-time32-be",
    recordBytes: 384,
    byteOrder: "big",
    sessionBytes: 4,
    sessionPadBytes: 0,
    sessionPadBefore: false,
    timeBytes: 4,
    addressSigned: true,
  },
  {
    name: "glibc-time64",
    recordBytes: 400,
    byteOrder: "little",
    sessionBytes: 8,
    sessionPadBytes: 0,
    sessionPadBefore: false,
    timeBytes: 8,
    addressSigned: true,
  },
  {
    name: "glibc-time64-be",
    recordBytes: 400,
    byteOrder: "big",
    sessionBytes: 8,
    sessionPadBytes: 0,
    sessionPadBefore: false,
    timeBytes: 8,
    addressSigned: true,
  },
  {
    name: "musl-time64",
    recordBytes: 400,
    byteOrder: "little",
    sessionBytes: 4,
    sessionPadBytes: 4,
    sessionPadBefore: false,
    timeBytes: 8,
    addressSigned: false,
  },
  {
    name: "musl-time64-be",
    recordBytes: 400,
    byteOrder: "big",
    sessionBytes: 4,
    sessionPadBytes: 4,
    sessionPadBefore: true,
    timeBytes: 8,
    addressSigned: false,
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
  /**
   * `ut_addr_v6` as four words, in the record's own encoding.
   *
   * glibc declares the member `int32_t`, so its words are signed; musl declares it
   * `unsigned`, so an all-ones word is `4294967295` rather than `-1`.
   */
  readonly addressV6: readonly number[];
  /** Fixed-width fields whose bytes were not well-formed UTF-8. */
  readonly undecodedFields: readonly UndecodedField[];
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
      readonly kind: "record_budget_exceeded";
      readonly limit: number;
      readonly omitted: number;
    }
  | {
      readonly kind: "undecoded_field";
      readonly fileOffset: number;
      readonly field: string;
    }
  | {
      readonly kind: "imprecise_field";
      readonly fileOffset: number;
      readonly field: string;
      /** The stored value in decimal, so the exact fact survives the rounding. */
      readonly exact: string;
    }
  | {
      readonly kind: "unknown_format";
      /** The unpublised profile name the caller supplied. */
      readonly name: string;
    }
  | {
      readonly kind: "invalid_record_budget";
      /** The rejected value as the caller supplied it, including `NaN`. */
      readonly value: string;
    };

export interface UtmpParseResult {
  /** `null` only for an empty file, which carries no layout facts of its own. */
  readonly profile: UtmpFormatProfile | null;
  readonly source: UtmpSource;
  readonly records: readonly UtmpRecord[];
  readonly issues: readonly UtmpIssue[];
}

/** Default ceiling on retained records, so a large or hostile log cannot amplify
 * the bytes already loaded into an unbounded object graph. */
export const UTMP_RECORD_LIMIT = 10_000;

interface FieldLayout {
  readonly sessionOffset: number;
  readonly secondsOffset: number;
  readonly microsecondsOffset: number;
  readonly addressOffset: number;
}

/** Where the tail fields sit once `ut_session` and `ut_tv` take their ABI width. */
export const utmpFieldLayout = (profile: UtmpFormatProfile): FieldLayout => {
  const sessionOffset =
    SESSION_OFFSET + (profile.sessionPadBefore ? profile.sessionPadBytes : 0);
  const afterSession =
    sessionOffset +
    profile.sessionBytes +
    (profile.sessionPadBefore ? 0 : profile.sessionPadBytes);
  const secondsOffset = afterSession;
  const microsecondsOffset = secondsOffset + profile.timeBytes;
  return {
    sessionOffset,
    secondsOffset,
    microsecondsOffset,
    addressOffset: microsecondsOffset + profile.timeBytes,
  };
};

/** Reinterpret an unsigned read as the signed field the record declares. */
const signed = (value: number | bigint, bits: 16 | 32 | 64): number =>
  Number(BigInt.asIntN(bits, BigInt(value)));

/**
 * Keep a 64-bit field exact.
 *
 * A supplied file can carry a session id or timestamp outside Number's exact
 * range. Rounding it silently collapses two distinct records onto one value, so
 * the stored decimal is reported alongside the number every consumer reads.
 */
const exactSigned = (
  word: number | bigint,
  bits: 32 | 64,
  field: string,
  fileOffset: number,
  issues: UtmpIssue[],
): number => {
  const value = BigInt.asIntN(bits, BigInt(word));
  const asNumber = Number(value);
  if (BigInt(asNumber) === value) return asNumber;
  issues.push({
    kind: "imprecise_field",
    fileOffset,
    field,
    exact: value.toString(),
  });
  return asNumber;
};

type DecodedField =
  | { readonly text: string; readonly decoded: true }
  | {
      readonly text: string;
      readonly decoded: false;
      /** The field's bytes up to its terminator, built only when they are bad. */
      readonly hex: string;
    };

/** A fixed-width member whose bytes were not well-formed UTF-8. */
export interface UndecodedField {
  readonly field: string;
  /**
   * The member's bytes up to its terminator, losslessly.
   *
   * The readable `text` keeps only the longest valid prefix, so `alice` + `0xff` +
   * `-admin` and a genuine `alice` would otherwise be indistinguishable.
   */
  readonly hex: string;
}

const decodeFixedWidth = (
  bytes: Buffer,
  base: number,
  offset: number,
  width: number,
): DecodedField => {
  const raw = bytes.subarray(base + offset, base + offset + width);
  const end = raw.indexOf(0);
  // glibc marks these members `__attribute_nonstring__`, so a field that fills
  // its whole width is well formed without a terminator; only malformed UTF-8
  // makes it unreadable.
  const used = end === -1 ? raw : raw.subarray(0, end);
  if (isStrictUtf8(used))
    return { text: decodeStrictUtf8(used, "preserve"), decoded: true };
  // Malformed bytes: keep the longest valid prefix and mark the field, so one bad
  // byte cannot abort the file or discard the records decoded before it.
  let prefix = used.length;
  while (prefix > 0 && !isStrictUtf8(used.subarray(0, prefix))) prefix -= 1;
  return {
    text:
      prefix === 0
        ? ""
        : decodeStrictUtf8(used.subarray(0, prefix), "preserve"),
    decoded: false,
    // Only a malformed field needs its bytes kept, so the encoding cost stays off
    // the path every valid record takes.
    hex: used.toString("hex"),
  };
};

/**
 * Decode `examined` records starting at the profile's first record.
 *
 * Kept separate from the file-level handling so a single record's field work does
 * not bury the budget, tail and profile logic.
 */
const decodeRecords = (
  bytes: Buffer,
  reader: BinaryReader,
  profile: UtmpFormatProfile,
  layout: FieldLayout,
  examined: number,
  issues: UtmpIssue[],
): UtmpRecord[] => {
  const records: UtmpRecord[] = [];

  for (let index = 0; index < examined; index += 1) {
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
    const type = signed(reader.u16(base + TYPE_OFFSET), 16);
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
      exitTermination: signed(reader.u16(base + EXIT_TERMINATION_OFFSET), 16),
      exitCode: signed(reader.u16(base + EXIT_CODE_OFFSET), 16),
      session: exactSigned(
        reader.word(
          base + layout.sessionOffset,
          profile.sessionBytes === 4 ? 32 : 64,
        ),
        profile.sessionBytes === 4 ? 32 : 64,
        "ut_session",
        base,
        issues,
      ),
      // `tv_sec` is a signed `time_t`, so a pre-epoch or clock-change value stays
      // negative instead of becoming a large positive one.
      timestampSeconds: exactSigned(
        reader.word(
          base + layout.secondsOffset,
          profile.timeBytes === 4 ? 32 : 64,
        ),
        profile.timeBytes === 4 ? 32 : 64,
        "ut_tv.tv_sec",
        base,
        issues,
      ),
      timestampMicroseconds: exactSigned(
        reader.word(
          base + layout.microsecondsOffset,
          profile.timeBytes === 4 ? 32 : 64,
        ),
        profile.timeBytes === 4 ? 32 : 64,
        "ut_tv.tv_usec",
        base,
        issues,
      ),
      addressV6: Array.from({ length: ADDRESS_V6_FIELDS }, (_, slot) => {
        const word = reader.u32(base + layout.addressOffset + slot * 4);
        return profile.addressSigned ? signed(word, 32) : word;
      }),
      undecodedFields: fields.flatMap(([field, decoded]) =>
        decoded.decoded ? [] : [{ field, hex: decoded.hex }],
      ),
    });
  }

  return records;
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
    readonly maxRecords?: number;
  },
): Result<UtmpParseResult, readonly UtmpIssue[]> => {
  const issues: UtmpIssue[] = [];
  // A count allowed by `number` but not by record semantics makes coverage and
  // the retention ceiling lie: `NaN` retains nothing, `1.5` keeps two records and
  // reports a fractional omission, `Infinity` removes the bound. Reject it instead
  // of clamping, so the diagnostics stay truthful — including for an empty file,
  // whose result must not depend on whether the log happened to carry bytes.
  const requestedLimit = options.maxRecords;
  if (
    requestedLimit !== undefined &&
    !(Number.isSafeInteger(requestedLimit) && requestedLimit >= 0)
  ) {
    issues.push({
      kind: "invalid_record_budget",
      value: String(requestedLimit),
    });
    return { ok: false, error: issues };
  }

  // A caller can hold a structurally valid profile whose fields do not describe
  // any published layout. The name is the identity, so resolve it and reject a
  // name that is not published rather than dividing by its `recordBytes`.
  const requested = options.profile;
  const canonical =
    requested === undefined
      ? undefined
      : UTMP_FORMAT_PROFILES.find(({ name }) => name === requested.name);
  if (requested !== undefined && canonical === undefined) {
    issues.push({ kind: "unknown_format", name: String(requested.name) });
    return { ok: false, error: issues };
  }

  if (input.byteLength === 0)
    return ok({
      profile: canonical === undefined ? null : canonical,
      source: options.source,
      records: [],
      issues,
    });

  // A truncated tail lets a larger record explain any shorter length, so the
  // length never proves the ABI on its own. Every profile stays a candidate —
  // narrowing by divisibility would advertise an ABI the bytes do not establish.
  const profile = canonical;
  if (profile === undefined) {
    issues.push({
      kind: "ambiguous_format",
      candidates: UTMP_FORMAT_PROFILES.map((candidate) => candidate.name),
    });
    return { ok: false, error: issues };
  }

  const little = profile.byteOrder === "little";
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reader = new BinaryReader(bytes, little, UTMP_FORMAT);
  const layout = utmpFieldLayout(profile);
  const whole = Math.floor(input.byteLength / profile.recordBytes);
  const remainder = input.byteLength - whole * profile.recordBytes;
  // A truncated tail can still carry every modeled field: the reserved words and
  // the struct padding sit at the end. Decoding it keeps the final login instead of
  // dropping it over bytes `UtmpRecord` never exposes.
  const modeledExtent = layout.addressOffset + ADDRESS_V6_FIELDS * 4;
  const decodable = remainder >= modeledExtent ? whole + 1 : whole;
  const limit = options.maxRecords ?? UTMP_RECORD_LIMIT;
  const examined = Math.min(decodable, limit);
  const records = decodeRecords(
    bytes,
    reader,
    profile,
    layout,
    examined,
    issues,
  );

  if (decodable > examined)
    issues.push({
      kind: "record_budget_exceeded",
      limit,
      omitted: decodable - examined,
    });

  if (remainder > 0)
    issues.push({
      kind: "truncated_trailing_bytes",
      fileOffset: whole * profile.recordBytes,
      bytes: remainder,
    });

  return ok({ profile, source: options.source, records, issues });
};
