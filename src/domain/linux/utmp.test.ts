import { describe, expect, it } from "vitest";

import {
  parseUtmpFile,
  utmpFieldLayout,
  UTMP_FORMAT_PROFILES,
  type UtmpFormatProfile,
} from "./utmp.js";

const profile = (name: UtmpFormatProfile["name"]): UtmpFormatProfile =>
  UTMP_FORMAT_PROFILES.find((candidate) => candidate.name === name)!;

const glibc32 = profile("glibc-time32");
const glibc64 = profile("glibc-time64");
const musl64 = profile("musl-time64");
const musl64be = profile("musl-time64-be");

interface RecordSpec {
  readonly type: number;
  readonly pid: number;
  readonly line: string;
  readonly id: string;
  readonly user: string;
  readonly host: string;
  readonly exitTermination?: number;
  readonly exitCode?: number;
  readonly session: number;
  readonly seconds: number;
  readonly microseconds: number;
  readonly addressV6?: readonly number[];
}

/**
 * Write one record using the offsets the parser derives, so a change to either
 * side makes the other disagree instead of both agreeing on a wrong layout.
 */
const recordBytes = (
  target: UtmpFormatProfile,
  spec: RecordSpec,
): Uint8Array => {
  const bytes = new Uint8Array(target.recordBytes);
  const view = new DataView(bytes.buffer);
  const little = target.byteOrder === "little";
  const layout = utmpFieldLayout(target);
  const writeFixed = (offset: number, width: number, text: string) => {
    const encoded = new TextEncoder().encode(text);
    bytes.set(encoded.subarray(0, width), offset);
  };
  view.setInt16(0, spec.type, little);
  view.setInt32(4, spec.pid, little);
  writeFixed(8, 32, spec.line);
  writeFixed(40, 4, spec.id);
  writeFixed(44, 32, spec.user);
  writeFixed(76, 256, spec.host);
  view.setInt16(332, spec.exitTermination ?? 0, little);
  view.setInt16(334, spec.exitCode ?? 0, little);
  if (target.sessionBytes === 4)
    view.setInt32(layout.sessionOffset, spec.session, little);
  else view.setBigInt64(layout.sessionOffset, BigInt(spec.session), little);
  if (target.timeBytes === 4) {
    view.setUint32(layout.secondsOffset, spec.seconds, little);
    view.setInt32(layout.microsecondsOffset, spec.microseconds, little);
  } else {
    view.setBigInt64(layout.secondsOffset, BigInt(spec.seconds), little);
    view.setBigInt64(
      layout.microsecondsOffset,
      BigInt(spec.microseconds),
      little,
    );
  }
  (spec.addressV6 ?? [0, 0, 0, 0]).forEach((word, slot) => {
    if (target.addressSigned)
      view.setInt32(layout.addressOffset + slot * 4, word, little);
    else view.setUint32(layout.addressOffset + slot * 4, word >>> 0, little);
  });
  return bytes;
};

const login = (overrides: Partial<RecordSpec> = {}): RecordSpec => ({
  type: 7,
  pid: 4242,
  line: "pts/0",
  id: "ts0",
  user: "analyst",
  host: "10.0.0.7",
  session: 12,
  seconds: 1_700_000_000,
  microseconds: 123_456,
  ...overrides,
});

describe("utmp profile selection", () => {
  it("keeps the published layouts distinct", () => {
    expect(glibc32.recordBytes).toBe(384);
    expect(glibc64.recordBytes).toBe(400);
    expect(utmpFieldLayout(glibc32).addressOffset).toBe(348);
    expect(utmpFieldLayout(glibc64).addressOffset).toBe(360);
  });

  it("places musl's session padding on the host-order side", () => {
    const little = utmpFieldLayout(musl64);
    const big = utmpFieldLayout(musl64be);
    // Little-endian musl: session id, then its pad.
    expect([
      little.sessionOffset,
      little.secondsOffset,
      little.addressOffset,
    ]).toEqual([336, 344, 360]);
    // Big-endian musl: the pad comes first so the pair stays in host order.
    expect([big.sessionOffset, big.secondsOffset, big.addressOffset]).toEqual([
      340, 344, 360,
    ]);
  });

  it("keeps every stated record size consistent with its own field arithmetic", () => {
    // The head, the tail and `__glibc_reserved[20]` must add up to the size the
    // profile advertises, padded to the 8-byte alignment `struct timeval` forces.
    for (const candidate of UTMP_FORMAT_PROFILES) {
      const layout = utmpFieldLayout(candidate);
      const end = layout.addressOffset + 4 * 4 + 20;
      expect(
        Math.ceil(end / 8) * 8,
        `${candidate.name} arithmetic disagrees with its record size`,
      ).toBe(candidate.recordBytes);
    }
  });

  it("keeps a truncated layout among the candidates at every record size", () => {
    // Dropping 16 bytes leaves a file that an exact-divisibility filter would
    // attribute to a smaller record, hiding the layout that actually wrote it.
    for (const candidate of UTMP_FORMAT_PROFILES) {
      const truncated = recordBytes(candidate, login()).subarray(
        0,
        candidate.recordBytes - 16,
      );
      const result = parseUtmpFile(truncated, { source: "wtmp" });
      expect(result.ok, candidate.name).toBe(false);
      if (result.ok) continue;
      expect(result.error).toEqual([
        {
          kind: "ambiguous_format",
          candidates: UTMP_FORMAT_PROFILES.map(({ name }) => name),
        },
      ]);
    }
  });
});

describe("utmp record decoding", () => {
  it("decodes a glibc 32-bit-time login record", () => {
    const result = parseUtmpFile(
      recordBytes(glibc32, login({ addressV6: [0x7f000001, 0, 0, 0] })),
      { source: "wtmp", profile: glibc32 },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.profile?.name).toBe("glibc-time32");
    expect(result.value.issues).toEqual([]);
    expect(result.value.records[0]).toMatchObject({
      fileOffset: 0,
      type: 7,
      typeName: "USER_PROCESS",
      pid: 4242,
      line: "pts/0",
      id: "ts0",
      user: "analyst",
      host: "10.0.0.7",
      session: 12,
      timestampSeconds: 1_700_000_000,
      timestampMicroseconds: 123_456,
      addressV6: [0x7f000001, 0, 0, 0],
      undecodedFields: [],
    });
  });

  it("decodes the glibc 64-bit-time layout at its own offsets", () => {
    const result = parseUtmpFile(
      recordBytes(
        glibc64,
        login({ session: 9_000_000_000, seconds: 1_800_000_000 }),
      ),
      { source: "wtmp", profile: glibc64 },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]).toMatchObject({
      session: 9_000_000_000,
      timestampSeconds: 1_800_000_000,
    });
  });

  it("shows the two 400-byte families disagreeing on the session field", () => {
    // A musl record whose padding is not zero. glibc reads bytes 336..344 as one
    // 64-bit session id, so the padding becomes its high half.
    const bytes = recordBytes(musl64, login({ session: 4_711 }));
    new DataView(bytes.buffer).setUint32(340, 1, true);
    const asGlibc = parseUtmpFile(bytes, { source: "wtmp", profile: glibc64 });
    if (!asGlibc.ok) throw new Error("expected a parsed record");
    expect(asGlibc.value.records[0]?.session).toBe(1 * 2 ** 32 + 4_711);
    const asMusl = parseUtmpFile(bytes, { source: "wtmp", profile: musl64 });
    if (!asMusl.ok) throw new Error("expected a parsed record");
    expect(asMusl.value.records[0]?.session).toBe(4_711);
  });

  it("pins musl's session offset without asking the layout helper", () => {
    const bytes = new Uint8Array(400);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 7, true);
    view.setUint32(336, 77, true); // ut_session, padding follows at 340
    view.setBigInt64(344, 1_700_000_000n, true); // tv_sec
    view.setBigInt64(352, 250n, true); // tv_usec
    view.setUint32(360, 0xffffffff, true); // ut_addr_v6[0], unsigned
    const result = parseUtmpFile(bytes, { source: "wtmp", profile: musl64 });
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]).toMatchObject({
      session: 77,
      timestampSeconds: 1_700_000_000,
      timestampMicroseconds: 250,
    });
    expect(result.value.records[0]?.addressV6[0]).toBe(0xffffffff);
  });

  it("decodes the big-endian musl layout", () => {
    const result = parseUtmpFile(
      recordBytes(musl64be, login({ session: 77, seconds: 1_600_000_000 })),
      { source: "utmp", profile: musl64be },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]).toMatchObject({
      session: 77,
      timestampSeconds: 1_600_000_000,
    });
  });

  it("keeps an unsigned musl address unsigned", () => {
    const result = parseUtmpFile(
      recordBytes(musl64, login({ addressV6: [0xffffffff, 0, 0, 0] })),
      { source: "wtmp", profile: musl64 },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]?.addressV6[0]).toBe(0xffffffff);
  });
});

describe("utmp diagnostics and bounds", () => {
  it("keeps every record when one carries a truncated tail", () => {
    const whole = recordBytes(glibc32, login());
    const bytes = new Uint8Array(whole.byteLength * 2 + 17);
    bytes.set(whole, 0);
    bytes.set(
      recordBytes(glibc32, login({ user: "second" })),
      whole.byteLength,
    );
    const result = parseUtmpFile(bytes, { source: "wtmp", profile: glibc32 });
    if (!result.ok) throw new Error("expected a parsed file");
    expect(result.value.records.map(({ user }) => user)).toEqual([
      "analyst",
      "second",
    ]);
    expect(result.value.issues).toEqual([
      { kind: "truncated_trailing_bytes", fileOffset: 768, bytes: 17 },
    ]);
  });

  it("keeps an unknown record type inspectable", () => {
    const result = parseUtmpFile(recordBytes(glibc32, login({ type: 240 })), {
      source: "btmp",
      profile: glibc32,
    });
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]).toMatchObject({
      type: 240,
      typeName: null,
    });
    expect(result.value.issues).toEqual([
      { kind: "unknown_type", fileOffset: 0, type: 240 },
    ]);
  });

  it("accepts a full-width field, which glibc does not require to be terminated", () => {
    // `ut_user` is `__attribute_nonstring__` and `ut_id` is four bytes wide, so a
    // field that fills its width with valid UTF-8 is normal evidence.
    const bytes = recordBytes(
      glibc32,
      login({ user: "x".repeat(32), id: "abcd" }),
    );
    const result = parseUtmpFile(bytes, { source: "utmp", profile: glibc32 });
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]?.user).toBe("x".repeat(32));
    expect(result.value.records[0]?.id).toBe("abcd");
    expect(result.value.issues).toEqual([]);
  });

  it("keeps the readable prefix of a malformed field instead of aborting", () => {
    const bytes = recordBytes(
      glibc32,
      login({ user: "ok", user2: undefined } as never),
    );
    // Overwrite the user field with a valid prefix followed by invalid bytes.
    bytes.set(new TextEncoder().encode("keep"), 44);
    bytes[48] = 0xff;
    bytes[49] = 0xfe;
    bytes[50] = 0;
    const result = parseUtmpFile(bytes, { source: "utmp", profile: glibc32 });
    if (!result.ok)
      throw new Error("expected a parsed record, not a throw or an error");
    expect(result.value.records[0]?.user).toBe("keep");
    expect(result.value.records[0]?.undecodedFields).toEqual(["user"]);
    expect(result.value.issues).toEqual([
      { kind: "undecoded_field", fileOffset: 0, field: "user" },
    ]);
  });
});

describe("utmp field widths and byte order", () => {
  it("keeps a negative timestamp negative", () => {
    const bytes = recordBytes(glibc32, login({ seconds: -1 }));
    const result = parseUtmpFile(bytes, { source: "wtmp", profile: glibc32 });
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]?.timestampSeconds).toBe(-1);
  });

  it("sign-extends a 16-bit field at its declared width", () => {
    const result = parseUtmpFile(
      recordBytes(glibc32, login({ type: 0xffff })),
      {
        source: "wtmp",
        profile: glibc32,
      },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]?.type).toBe(-1);
  });

  it("bounds retained records and reports what it omitted", () => {
    const one = recordBytes(glibc32, login());
    const bytes = new Uint8Array(one.byteLength * 4);
    for (let index = 0; index < 4; index += 1)
      bytes.set(
        recordBytes(glibc32, login({ pid: index })),
        index * one.byteLength,
      );
    const result = parseUtmpFile(bytes, {
      source: "wtmp",
      profile: glibc32,
      maxRecords: 2,
    });
    if (!result.ok) throw new Error("expected a parsed file");
    expect(result.value.records).toHaveLength(2);
    expect(result.value.issues).toContainEqual({
      kind: "record_budget_exceeded",
      limit: 2,
      omitted: 2,
    });
  });

  it("requires a stated profile because a truncated tail fits any length", () => {
    // 384 bytes is exactly one x86 record, but it is also an aarch64 record
    // truncated by 16 bytes, so the length cannot choose the layout.
    const result = parseUtmpFile(recordBytes(glibc32, login()), {
      source: "wtmp",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual([
      {
        kind: "ambiguous_format",
        candidates: UTMP_FORMAT_PROFILES.map(({ name }) => name),
      },
    ]);
  });

  it("pins the published offsets without asking the layout helper", () => {
    // Literal offsets, so a wrong derivation cannot make the fixture agree with it.
    const bytes = new Uint8Array(384);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 7, true);
    view.setInt32(4, 99, true);
    bytes.set(new TextEncoder().encode("tty1"), 8);
    view.setInt32(336, 34, true); // ut_session
    view.setInt32(340, 1_234, true); // tv_sec
    view.setInt32(344, 5, true); // tv_usec
    const result = parseUtmpFile(bytes, { source: "utmp", profile: glibc32 });
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]).toMatchObject({
      type: 7,
      pid: 99,
      line: "tty1",
      session: 34,
      timestampSeconds: 1_234,
      timestampMicroseconds: 5,
    });
  });

  it("returns an empty result for an empty file", () => {
    const result = parseUtmpFile(new Uint8Array(0), { source: "utmp" });
    if (!result.ok) throw new Error("expected an empty result");
    expect(result.value.records).toEqual([]);
    expect(result.value.issues).toEqual([]);
    expect(result.value.profile).toBeNull();
  });

  it("reports an ambiguous file as an error rather than decoding it", () => {
    const result = parseUtmpFile(new Uint8Array(9_600), { source: "wtmp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.kind).toBe("ambiguous_format");
  });
});
