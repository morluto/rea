import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectV8CodeCacheInputSchema,
  v8CodeCacheSchema,
  V8_CODE_CACHE_HEADER_BYTES,
  V8_CODE_CACHE_MAGIC_HIGH,
  V8_CODE_CACHE_NARROW_HEADER_BYTES,
  type V8CodeCache,
} from "../domain/v8/v8CodeCache.js";
import { parseV8CodeCache } from "./V8CodeCacheParser.js";
import {
  v8CodeCacheFixture,
  v8FunctionCodeCacheFixture,
  withHeaderWord,
  withSyntheticNarrowHeader,
} from "./V8CodeCache.fixture.js";

const defaults = inspectV8CodeCacheInputSchema.parse({
  path: "/artifacts/module.jsc",
});

const identity = (bytes: Buffer) => ({
  path: "/artifacts/module.jsc",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

const parse = (bytes: Buffer): V8CodeCache => {
  const report = parseV8CodeCache(bytes, identity(bytes), defaults);
  const validated = v8CodeCacheSchema.safeParse(report);
  if (!validated.success) throw new Error(validated.error.message);
  return report;
};

const real = v8CodeCacheFixture();

it("reports the observed header of a real V8 code cache", () => {
  const report = parse(real);
  expect(report.header.header_bytes).toBe(32);
  expect(report.header.magic_build_stable).toBe(0xc0de);
  expect(report.header.magic).toBe(real.readUInt32LE(0));
  // The payload-length word reaches exactly the end of the container.
  expect(report.payload.offset).toBe(32);
  expect(report.payload.bytes).toBe(real.length - 32);
  expect(report.payload.bytes).toBe(real.readUInt32LE(20));
  expect(report.payload.offset + report.payload.bytes).toBe(
    report.artifact.bytes,
  );
  expect(report.coverage.status).toBe("complete");
});

it("names every header word with its role and confidence", () => {
  const report = parse(real);
  expect(report.header.fields).toHaveLength(8);
  expect(report.header.fields.map((field) => field.offset)).toEqual([
    0, 4, 8, 12, 16, 20, 24, 28,
  ]);
  expect(report.header.fields.map((field) => field.role)).toEqual([
    "magic",
    "version_hash",
    "source_length",
    "flag_hash",
    "build_constant",
    "payload_length",
    "reserved",
    "reserved",
  ]);
  // Every reported value is the byte-level truth, independent of the inferred role.
  report.header.fields.forEach((field) => {
    expect(field.value).toBe(real.readUInt32LE(field.offset));
  });
  // Confidence is stated per field rather than implied.
  expect(
    report.header.fields.filter((field) => field.status === "unconfirmed"),
  ).toHaveLength(2);
  expect(
    report.header.fields
      .filter((field) => field.status === "confirmed")
      .map((f) => f.role),
  ).toEqual(["magic", "source_length", "payload_length"]);
});

it("reports the source length the producer recorded", () => {
  const source = "function longer(a, b) { return a * b + 1; } longer(3, 4);";
  const cache = v8CodeCacheFixture(source);
  const report = parse(cache);
  expect(report.header.source_length).toBe(source.length);
  // An unflagged word is `unknown`, not `script`: a `vm.compileFunction` cache from a
  // build that does not mark bit 29 reads the same as a script, so the container alone
  // cannot separate them. The observed word stays available in `header.fields`.
  expect(report.header.producer).toBe("unknown");
  expect(report.header.fields[2]?.value).toBe(cache.readUInt32LE(8));
});

it.each([
  [0x20000000, "compile_function"],
  [0x40000000, "module"],
  [0x80000000, "module"],
  [0x60000000, "module"],
] as const)(
  "interprets producer flags %i without changing source length",
  (flags, producer) => {
    // Older V8 uses bit 31 for modules. A synthetic word with both bits set
    // checks that the module marker wins over the function marker.
    const sourceLength = 19;
    const cache = withHeaderWord(real, 2, flags | sourceLength);
    expect(parse(cache).header).toMatchObject({
      producer,
      source_length: sourceLength,
    });
  },
);

it("separates the compileFunction producer bit from the source length", () => {
  const source = "return 7;";
  const cache = v8FunctionCodeCacheFixture(source);
  const word = cache.readUInt32LE(8);
  const report = parse(cache);
  // Whether `vm.compileFunction` sets bit 29 in the source-length word is a V8 build
  // detail, not a contract: Node 24.22.1 writes `0x20000009` for this source while Node
  // 22.23.4 does not set the bit at all. Assert against the word the runtime produced
  // rather than against one build's spelling, so the check is about the parser reading
  // that word correctly; the flag meanings themselves are pinned by the synthetic
  // `withHeaderWord` cases above.
  expect(report.header.producer).toBe(
    (word & 0x20000000) === 0 ? "unknown" : "compile_function",
  );
  // The source length is the low bits either way, so it is the part that must hold.
  expect(report.header.source_length).toBe(source.length);
});

it("reports an embedded run at its absolute file offset", () => {
  const marker = "UNIQUE_CONFIG_KEY_9f3a";
  // An object-literal value survives in the serialized payload as plain bytes.
  const cache = v8CodeCacheFixture(
    `var settings = { key: "${marker}" }; settings.key;`,
  );
  const report = parse(cache);
  const observation = report.embedded_strings.find((entry) =>
    entry.text.includes(marker),
  );
  expect(observation).toBeDefined();
  // The reported range points at the marker inside the selected file.
  expect(realSlice(cache, observation!.offset, observation!.bytes)).toContain(
    marker,
  );
  expect(observation!.offset).toBeGreaterThanOrEqual(32);
  expect(report.coverage.strings).toBe(report.embedded_strings.length);
});

it("labels observations as byte patterns and never claims recovered source", () => {
  const report = parse(real);
  expect(report.limitations.join(" ")).toContain("byte-pattern observations");
  expect(report.limitations.join(" ")).toContain("not source");
  expect(report.limitations.join(" ")).toContain("View8");
  // No field can be mistaken for recovered source text.
  expect(Object.keys(report)).not.toContain("source");
});

it("fails closed on a foreign magic", () => {
  const foreign = withHeaderWord(real, 0, 0xdeadbeef);
  expect(() => parse(foreign)).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "unsupported",
        format: "v8-code-cache",
      }),
      message: expect.stringContaining("not a V8 code cache"),
    }),
  );
});

it("fails closed on a truncated header", () => {
  expect(() =>
    parse(real.subarray(0, V8_CODE_CACHE_NARROW_HEADER_BYTES - 1)),
  ).toThrow(expect.objectContaining({ kind: "malformed" }));
});

it("treats the observed header as version-dependent rather than a fixed ABI", () => {
  // A producer with a different build constant and version hash is still admitted: only
  // the magic high half and the payload-length relation gate admission.
  const otherBuild = withHeaderWord(
    withHeaderWord(real, 4, 0x4be86e94),
    1,
    0x11111111,
  );
  const report = parse(otherBuild);
  expect(report.header.fields[4]?.value).toBe(0x4be86e94);
  expect(report.payload.bytes).toBe(real.readUInt32LE(20));
});

it("enforces the caller-selected observation budget", () => {
  const crowded = v8CodeCacheFixture(
    `var a = { a: "AAAAAAAAAAAA", b: "BBBBBBBBBBBB", c: "CCCCCCCCCCCC" }; a.a;`,
  );
  expect(() =>
    parseV8CodeCache(crowded, identity(crowded), {
      ...defaults,
      max_strings: 1,
    }),
  ).toThrow(
    expect.objectContaining({
      name: "ParseFailureError",
      failure: expect.objectContaining({
        kind: "limit",
        format: "v8-code-cache",
        limit: { name: "max_strings", maximum: 1 },
      }),
      message: expect.stringContaining("max_strings"),
    }),
  );
});

it("raises min_string_bytes and reports only runs that long", () => {
  const bytes = v8CodeCacheFixture(
    `var a = { k: "SHORT", long: "${"L".repeat(80)}" }; a.k;`,
  );
  const few = parseV8CodeCache(bytes, identity(bytes), {
    ...defaults,
    min_string_bytes: 64,
  });
  expect(few.embedded_strings.length).toBeGreaterThan(0);
  few.embedded_strings.forEach((entry) => {
    expect(entry.bytes).toBeGreaterThanOrEqual(64);
  });
});

const realSlice = (bytes: Buffer, offset: number, length: number): string =>
  bytes.subarray(offset, offset + length).toString("latin1");

it("inspects a synthetic narrow layout derived from a 64-bit cache", () => {
  // Removing the alignment word preserves the retained payload bytes.
  const narrow = withSyntheticNarrowHeader(real);
  const report = parse(narrow);

  expect(narrow.readUInt32LE(20)).toBe(
    narrow.length - V8_CODE_CACHE_NARROW_HEADER_BYTES,
  );
  expect(report.header.header_bytes).toBe(V8_CODE_CACHE_NARROW_HEADER_BYTES);
  expect(report.payload.offset).toBe(V8_CODE_CACHE_NARROW_HEADER_BYTES);
  // Nothing but the padding is removed, so the payload is identical.
  expect(report.payload.sha256).toBe(parse(real).payload.sha256);
  // The word table covers exactly the header this container carries.
  expect(report.header.fields).toHaveLength(7);
  expect(report.header.fields.map((entry) => entry.offset)).toEqual([
    0, 4, 8, 12, 16, 20, 24,
  ]);
});

it("fails closed when the declared payload leaves no admitted header size", () => {
  // Padding that is neither 28 nor 32 bytes is not a container this reader admits.
  expect(() =>
    parse(
      Buffer.concat([
        real.subarray(0, V8_CODE_CACHE_NARROW_HEADER_BYTES + 2),
        real.subarray(V8_CODE_CACHE_HEADER_BYTES),
      ]),
    ),
  ).toThrow(expect.objectContaining({ kind: "malformed" }));
});

it("refuses a wide container that is only four bytes short", () => {
  // Truncating a 32-byte-header cache by four bytes makes `bytes.length - declaredPayload`
  // equal 28. The padding then occupies the same position as a zero first
  // payload word in a narrow container, so the reader refuses the ambiguity.
  const short = real.subarray(0, real.length - 4);
  expect(short.readUInt32LE(28)).toBe(0);
  expect(() => parse(short)).toThrow(
    expect.objectContaining({
      kind: "malformed",
      message: expect.stringContaining("ambiguous"),
    }),
  );
  // A synthetic narrow fixture has payload at the same byte offset.
  const narrow = withSyntheticNarrowHeader(real);
  expect(narrow.readUInt32LE(V8_CODE_CACHE_NARROW_HEADER_BYTES)).not.toBe(0);
  expect(parse(narrow).header.header_bytes).toBe(
    V8_CODE_CACHE_NARROW_HEADER_BYTES,
  );
});

it("rejects a reported word table that does not cover the header it declares", () => {
  // The parser derives both from one offset, so this pair cannot disagree on a
  // parsed container; the schema is what a stored or projected report also goes
  // through, and there the two are independent fields. Without these cases the
  // rule could be deleted and every parser test would still pass.
  const reported = (fieldCount: number, headerBytes: number) => ({
    artifact: {
      path: "/artifacts/module.jsc",
      sha256: "a".repeat(64),
      bytes: 4096,
    },
    header: {
      magic: 0xf00d,
      magic_build_stable: V8_CODE_CACHE_MAGIC_HIGH,
      fields: Array.from({ length: fieldCount }, (_, index) => ({
        offset: index * 4,
        value: index,
        role: "reserved",
        status: "unconfirmed" as const,
      })),
      header_bytes: headerBytes,
      source_length: 10,
      producer: "script" as const,
    },
    payload: {
      offset: headerBytes,
      bytes: 4096 - headerBytes,
      sha256: "b".repeat(64),
      trailing_bytes: 0,
    },
    embedded_strings: [],
    coverage: {
      status: "complete" as const,
      scanned_bytes: 4096 - headerBytes,
      strings: 0,
    },
    limitations: ["measured on one producer"],
  });

  // Seven words is 28 bytes and eight is 32, so each header size has exactly one
  // word count that covers it.
  const cases = [
    { fields: 7, bytes: V8_CODE_CACHE_HEADER_BYTES, accepted: false },
    { fields: 8, bytes: V8_CODE_CACHE_NARROW_HEADER_BYTES, accepted: false },
    { fields: 7, bytes: V8_CODE_CACHE_NARROW_HEADER_BYTES, accepted: true },
    { fields: 8, bytes: V8_CODE_CACHE_HEADER_BYTES, accepted: true },
  ];
  for (const { fields, bytes, accepted } of cases) {
    const label = `${String(fields)} words / ${String(bytes)} bytes`;
    const parsed = v8CodeCacheSchema.safeParse(reported(fields, bytes));
    expect(parsed.success, label).toBe(accepted);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.path.join(".") === "header.fields",
      ) ?? false,
      label,
    ).toBe(!accepted);
  }
});

it("rejects retained header and payload coordinates that disagree", () => {
  const report = parse(real);
  const disordered = {
    ...report,
    header: {
      ...report.header,
      fields: report.header.fields.map((field, index) =>
        index === 0 ? { ...field, offset: 4 } : field,
      ),
    },
  };
  const shiftedPayload = {
    ...report,
    artifact: { ...report.artifact, bytes: report.artifact.bytes + 4 },
    payload: { ...report.payload, offset: report.payload.offset + 4 },
  };
  expect(
    v8CodeCacheSchema.safeParse(disordered).error?.issues ?? [],
  ).toContainEqual(expect.objectContaining({ path: ["header", "fields"] }));
  expect(
    v8CodeCacheSchema.safeParse(shiftedPayload).error?.issues ?? [],
  ).toContainEqual(expect.objectContaining({ path: ["payload", "offset"] }));
});
