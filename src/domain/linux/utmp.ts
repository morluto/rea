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

/** The trailing reserved member both libcs reserve, in bytes. */
const RESERVED_BYTES = 20;

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
  /** The name the profile gives its trailing reserved member. */
  readonly reservedMemberName: string;
}

/**
 * Supported layouts.
 *
 * The `-time32` pair is the `__WORDSIZE_TIME64_COMPAT32` shape glibc carries on
 * x86-64 and, byte-swapped, on the big-endian targets that define the macro
 * (`s390x`, big-endian `ppc64`). The `-time64` family is the `long`-typed shape,
 * which glibc's aarch64 port carries in both byte orders.
 */
export const UTMP_FORMAT_PROFILES: readonly UtmpFormatProfile[] = Object.freeze(
  [
    {
      name: "glibc-time32",
      recordBytes: 384,
      byteOrder: "little",
      sessionBytes: 4,
      sessionPadBytes: 0,
      sessionPadBefore: false,
      timeBytes: 4,
      addressSigned: true,
      reservedMemberName: "__glibc_reserved",
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
      reservedMemberName: "__glibc_reserved",
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
      reservedMemberName: "__glibc_reserved",
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
      reservedMemberName: "__glibc_reserved",
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
      reservedMemberName: "__unused",
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
      reservedMemberName: "__unused",
    },
  ].map((candidate) => Object.freeze(candidate) as UtmpFormatProfile),
);

export interface UtmpRecord {
  /** Byte offset of this record from the start of the supplied file. */
  readonly fileOffset: number;
  readonly type: number;
  /** Name of `type` when glibc defines one, so an unknown value stays readable. */
  readonly typeName: string | null;
  /**
   * Members after `ut_type` are `null` when a truncated tail does not hold them
   * whole; `coverage.missing` names them, so an absent member is never a zero.
   */
  readonly pid: number | null;
  readonly line: string | null;
  readonly id: string | null;
  readonly user: string | null;
  readonly host: string | null;
  readonly exitTermination: number | null;
  readonly exitCode: number | null;
  readonly session: number | null;
  readonly timestampSeconds: number | null;
  readonly timestampMicroseconds: number | null;
  /**
   * `ut_addr_v6` as four words, in the record's own encoding.
   *
   * glibc declares the member `int32_t`, so its words are signed; musl declares it
   * `unsigned`, so an all-ones word is `4294967295` rather than `-1`.
   */
  readonly addressV6: readonly number[];
  /** Fixed-width fields whose bytes were not well-formed UTF-8. */
  readonly undecodedFields: readonly UndecodedField[];
  /**
   * Which declared members the record's bytes held whole. A truncated tail keeps
   * every member it reaches; the rest are named here and reported as `null`.
   */
  readonly coverage: UtmpCoverage;
}

export interface UtmpCoverage {
  /** Whether every member this reader models was present. */
  readonly complete: boolean;
  /** The members the record's bytes did not reach, in record order. */
  readonly missing: readonly string[];
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

const decodeFixedWidth = (raw: Buffer): DecodedField => {
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

/** One declared member of `struct utmp`: its name, offset and width. */
interface UtmpMember {
  readonly name: string;
  readonly offset: number;
  readonly bytes: number;
}

/**
 * Every declared member in record order, from the profile's own layout. This is
 * the single description of where each member sits; decoding, coverage and the
 * tail rule all read it, so none of them carries its own offset arithmetic.
 * Struct padding after the reserved member is not a member.
 */
export const utmpMembers = (
  profile: UtmpFormatProfile,
): readonly UtmpMember[] => {
  const layout = utmpFieldLayout(profile);
  return [
    { name: "ut_type", offset: TYPE_OFFSET, bytes: 2 },
    { name: "ut_pid", offset: PID_OFFSET, bytes: 4 },
    { name: "ut_line", offset: LINE_OFFSET, bytes: LINE_BYTES },
    { name: "ut_id", offset: ID_OFFSET, bytes: ID_BYTES },
    { name: "ut_user", offset: USER_OFFSET, bytes: USER_BYTES },
    { name: "ut_host", offset: HOST_OFFSET, bytes: HOST_BYTES },
    {
      name: "ut_exit.e_termination",
      offset: EXIT_TERMINATION_OFFSET,
      bytes: 2,
    },
    { name: "ut_exit.e_exit", offset: EXIT_CODE_OFFSET, bytes: 2 },
    {
      name: "ut_session",
      offset: layout.sessionOffset,
      bytes: profile.sessionBytes,
    },
    {
      name: "ut_tv.tv_sec",
      offset: layout.secondsOffset,
      bytes: profile.timeBytes,
    },
    {
      name: "ut_tv.tv_usec",
      offset: layout.microsecondsOffset,
      bytes: profile.timeBytes,
    },
    ...Array.from({ length: ADDRESS_V6_FIELDS }, (_, slot) => ({
      name: `ut_addr_v6[${String(slot)}]`,
      offset: layout.addressOffset + slot * 4,
      bytes: 4,
    })),
    {
      name: profile.reservedMemberName,
      offset: layout.addressOffset + ADDRESS_V6_FIELDS * 4,
      bytes: RESERVED_BYTES,
    },
  ];
};

/**
 * Decode `examined` records starting at the profile's first record. A record
 * whose bytes end early keeps every member it holds whole and names the rest.
 */
const decodeRecords = (
  bytes: Buffer,
  reader: BinaryReader,
  profile: UtmpFormatProfile,
  examined: number,
  issues: UtmpIssue[],
): UtmpRecord[] => {
  const members = utmpMembers(profile);
  const memberAt = new Map(members.map((member) => [member.name, member]));
  const records: UtmpRecord[] = [];

  for (let index = 0; index < examined; index += 1) {
    const base = index * profile.recordBytes;
    const available = Math.min(profile.recordBytes, bytes.length - base);
    const holds = (member: UtmpMember): boolean =>
      member.offset + member.bytes <= available;
    const present = (name: string): UtmpMember | undefined => {
      const member = memberAt.get(name)!;
      return holds(member) ? member : undefined;
    };
    const missing = members
      .filter((member) => !holds(member))
      .map(({ name }) => name);

    const text = (name: string, field: string): string | null => {
      const member = present(name);
      if (member === undefined) return null;
      const decoded = decodeFixedWidth(
        bytes.subarray(
          base + member.offset,
          base + member.offset + member.bytes,
        ),
      );
      if (!decoded.decoded) {
        issues.push({ kind: "undecoded_field", fileOffset: base, field });
        undecodedFields.push({ field, hex: decoded.hex });
      }
      return decoded.text;
    };
    const integer = (name: string, bits: 16 | 32): number | null => {
      const member = present(name);
      if (member === undefined) return null;
      const word =
        bits === 16
          ? reader.u16(base + member.offset)
          : reader.u32(base + member.offset);
      return signed(word, bits);
    };
    // `ut_session` and `ut_tv` take the ABI's width; a 64-bit value Number cannot
    // hold exactly is reported beside the rounded one.
    const wide = (name: string): number | null => {
      const member = present(name);
      if (member === undefined) return null;
      const bits = member.bytes === 4 ? 32 : 64;
      return exactSigned(
        reader.word(base + member.offset, bits),
        bits,
        name,
        base,
        issues,
      );
    };

    const undecodedFields: UndecodedField[] = [];
    const type = signed(reader.u16(base + TYPE_OFFSET), 16);
    const typeName = UTMP_TYPE_NAMES.get(type) ?? null;
    if (typeName === null)
      issues.push({ kind: "unknown_type", fileOffset: base, type });
    const line = text("ut_line", "line");
    const id = text("ut_id", "id");
    const user = text("ut_user", "user");
    const host = text("ut_host", "host");
    records.push({
      fileOffset: base,
      type,
      typeName,
      pid: integer("ut_pid", 32),
      line,
      id,
      user,
      host,
      exitTermination: integer("ut_exit.e_termination", 16),
      exitCode: integer("ut_exit.e_exit", 16),
      session: wide("ut_session"),
      // `tv_sec` is a signed `time_t`, so a pre-epoch or clock-change value stays
      // negative instead of becoming a large positive one.
      timestampSeconds: wide("ut_tv.tv_sec"),
      timestampMicroseconds: wide("ut_tv.tv_usec"),
      addressV6: members
        .filter(
          (member) => member.name.startsWith("ut_addr_v6[") && holds(member),
        )
        .map((member) => {
          const word = reader.u32(base + member.offset);
          return profile.addressSigned ? signed(word, 32) : word;
        }),
      coverage: { complete: missing.length === 0, missing },
      undecodedFields,
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
  const whole = Math.floor(input.byteLength / profile.recordBytes);
  const remainder = input.byteLength - whole * profile.recordBytes;
  // A truncated tail is a record as soon as it holds `ut_type` whole: every
  // later member it reaches is decoded and the rest are named in its coverage,
  // so complete members are never dropped for the ones that are missing.
  const typeMember = utmpMembers(profile)[0]!;
  const tailDecodable = remainder >= typeMember.offset + typeMember.bytes;
  const decodable = tailDecodable ? whole + 1 : whole;
  const limit = options.maxRecords ?? UTMP_RECORD_LIMIT;
  const examined = Math.min(decodable, limit);
  const records = decodeRecords(bytes, reader, profile, examined, issues);

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
