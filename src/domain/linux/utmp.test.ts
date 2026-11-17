import { describe, expect, it } from "vitest";

import {
  parseUtmpFile,
  selectUtmpProfile,
  utmpFieldLayout,
  utmpProfileCandidates,
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

  it("derives the candidate profiles from the file length", () => {
    expect(utmpProfileCandidates(384).map(({ name }) => name)).toEqual([
      "glibc-time32",
    ]);
    expect(utmpProfileCandidates(400).map(({ name }) => name)).toEqual([
      "glibc-time64",
      "glibc-time64-be",
      "musl-time64",
      "musl-time64-be",
    ]);
    // 9600 is the least common multiple, so the length cannot name one layout.
    expect(utmpProfileCandidates(9_600)).toHaveLength(5);
  });

  it("refuses an ambiguous file instead of guessing", () => {
    const selection = selectUtmpProfile(9_600);
    expect("ambiguous" in selection).toBe(true);
    expect(
      "ambiguous" in selection
        ? selection.ambiguous.map(({ name }) => name)
        : [],
    ).toHaveLength(5);
  });

  it("honours an explicit profile for a length several layouts share", () => {
    const selection = selectUtmpProfile(400, musl64);
    expect("profile" in selection && selection.profile.name).toBe(
      "musl-time64",
    );
  });
});

describe("utmp record decoding", () => {
  it("decodes a glibc 32-bit-time login record", () => {
    const result = parseUtmpFile(
      recordBytes(glibc32, login({ addressV6: [0x7f000001, 0, 0, 0] })),
      { source: "wtmp" },
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

  it("keeps the wider glibc session id out of musl's padding", () => {
    const bytes = recordBytes(musl64, login({ session: 4_711 }));
    const asGlibc = parseUtmpFile(bytes, { source: "wtmp", profile: glibc64 });
    if (!asGlibc.ok) throw new Error("expected a parsed record");
    // glibc reads the four padding bytes as the session's high half, so the two
    // layouts disagree on this file; that is why the caller must state one.
    expect(asGlibc.value.records[0]?.session).toBe(4_711);
    const asMusl = parseUtmpFile(bytes, { source: "wtmp", profile: musl64 });
    if (!asMusl.ok) throw new Error("expected a parsed record");
    expect(asMusl.value.records[0]?.session).toBe(4_711);
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

  it("reports a fixed-width field that carries no terminator", () => {
    const bytes = recordBytes(glibc32, login({ user: "x".repeat(32) }));
    const result = parseUtmpFile(bytes, { source: "utmp" });
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.records[0]?.user).toBe("x".repeat(32));
    expect(result.value.issues).toEqual([
      { kind: "undecoded_field", fileOffset: 0, field: "user" },
    ]);
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
