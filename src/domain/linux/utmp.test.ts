import { describe, expect, it } from "vitest";

import {
  parseUtmpFile,
  selectUtmpProfile,
  utmpFieldLayout,
  utmpProfileCandidates,
  UTMP_FORMAT_PROFILES,
} from "./utmp.js";

const x86 = UTMP_FORMAT_PROFILES.find(({ name }) => name === "linux-x86-64")!;
const arm64 = UTMP_FORMAT_PROFILES.find(
  ({ name }) => name === "linux-aarch64",
)!;

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
  profile: (typeof UTMP_FORMAT_PROFILES)[number],
  spec: RecordSpec,
): Uint8Array => {
  const bytes = new Uint8Array(profile.recordBytes);
  const view = new DataView(bytes.buffer);
  const little = profile.byteOrder === "little";
  const layout = utmpFieldLayout(profile);
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
  if (profile.sessionBytes === 4)
    view.setInt32(layout.sessionOffset, spec.session, little);
  else view.setBigInt64(layout.sessionOffset, BigInt(spec.session), little);
  if (profile.timeBytes === 4) {
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
    view.setInt32(layout.addressOffset + slot * 4, word, little);
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
  it("keeps the two published layouts distinct", () => {
    const x86Layout = utmpFieldLayout(x86);
    const arm64Layout = utmpFieldLayout(arm64);
    expect(x86.recordBytes).toBe(384);
    expect(arm64.recordBytes).toBe(400);
    expect(x86Layout.addressOffset).toBe(348);
    expect(arm64Layout.addressOffset).toBe(360);
  });

  it("derives the candidate profiles from the file length", () => {
    expect(utmpProfileCandidates(384).map(({ name }) => name)).toEqual([
      "linux-x86-64",
    ]);
    expect(utmpProfileCandidates(400).map(({ name }) => name)).toEqual([
      "linux-aarch64",
      "linux-aarch64-be",
    ]);
    // 9600 is the least common multiple, so the bytes cannot name one ABI.
    expect(utmpProfileCandidates(9_600).map(({ name }) => name)).toEqual([
      "linux-x86-64",
      "linux-aarch64",
      "linux-aarch64-be",
    ]);
  });

  it("refuses an ambiguous file instead of guessing", () => {
    const selection = selectUtmpProfile(9_600);
    expect("ambiguous" in selection).toBe(true);
    expect(
      "ambiguous" in selection
        ? selection.ambiguous.map(({ name }) => name)
        : [],
    ).toEqual(["linux-x86-64", "linux-aarch64", "linux-aarch64-be"]);
  });

  it("honours an explicit profile for an ambiguous length", () => {
    const selection = selectUtmpProfile(9_600, arm64);
    expect("profile" in selection && selection.profile.name).toBe(
      "linux-aarch64",
    );
  });
});

describe("utmp record decoding", () => {
  it("decodes an x86-64 login record", () => {
    const result = parseUtmpFile(
      recordBytes(x86, login({ addressV6: [0x7f000001, 0, 0, 0] })),
      { source: "wtmp" },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.profile?.name).toBe("linux-x86-64");
    expect(result.value.issues).toEqual([]);
    expect(result.value.records).toHaveLength(1);
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

  it("decodes the wider aarch64 layout at its own offsets", () => {
    // 400 bytes names the record size but not the byte order, so the caller
    // states the ABI it expects.
    const result = parseUtmpFile(
      recordBytes(
        arm64,
        login({ session: 9_000_000_000, seconds: 1_800_000_000 }),
      ),
      { source: "wtmp", profile: arm64 },
    );
    if (!result.ok) throw new Error("expected a parsed record");
    expect(result.value.profile?.name).toBe("linux-aarch64");
    expect(result.value.records[0]).toMatchObject({
      session: 9_000_000_000,
      timestampSeconds: 1_800_000_000,
    });
  });

  it("keeps every record when one carries a truncated tail", () => {
    const whole = recordBytes(x86, login());
    const bytes = new Uint8Array(whole.byteLength * 2 + 17);
    bytes.set(whole, 0);
    bytes.set(recordBytes(x86, login({ user: "second" })), whole.byteLength);
    const result = parseUtmpFile(bytes, { source: "wtmp", profile: x86 });
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
    const result = parseUtmpFile(recordBytes(x86, login({ type: 240 })), {
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
    const bytes = recordBytes(x86, login({ user: "x".repeat(32) }));
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
    const bytes = new Uint8Array(9_600);
    const result = parseUtmpFile(bytes, { source: "wtmp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual([
      {
        kind: "ambiguous_format",
        candidates: ["linux-x86-64", "linux-aarch64", "linux-aarch64-be"],
      },
    ]);
  });
});
