import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectV8CodeCacheInputSchema,
  MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES,
  v8CodeCacheSchema,
  V8_CODE_CACHE_HEADER_BYTES,
  V8_CODE_CACHE_LEGACY_HEADER_BYTES,
  V8_CODE_CACHE_NARROW_HEADER_BYTES,
  type V8CodeCache,
} from "../domain/v8/v8CodeCache.js";
import { parseV8CodeCacheFromHandle } from "./V8CodeCacheParser.js";
import {
  v8CodeCacheFixture,
  v8FunctionCodeCacheFixture,
  withHeaderWord,
  withSyntheticLegacyHeader,
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

const parse = async (bytes: Buffer): Promise<V8CodeCache> =>
  v8CodeCacheSchema.parse(
    await parseV8CodeCacheFromHandle(
      {
        size: bytes.length,
        prefix: bytes,
        readRange: async () => {
          throw new Error(
            "The admitted prefix already contains the test cache",
          );
        },
      },
      identity(bytes),
      defaults,
    ),
  );

const source = 'const label = "🦎"; label;';
const real = v8CodeCacheFixture(source);

it("reports real V8 words, their confidence and the UTF-16 source length", async () => {
  const report = await parse(real);
  expect(report.header).toMatchObject({
    magic: real.readUInt32LE(0),
    magic_build_stable: 0xc0de,
    header_bytes: 32,
    source_length: source.length,
    producer: "unknown",
  });
  const headerWords = [
    ["magic", "confirmed"],
    ["version_hash", "inferred"],
    ["source_length", "confirmed"],
    ["flag_hash", "inferred"],
    ["build_constant", "inferred"],
    ["payload_length", "confirmed"],
    ["reserved", "unconfirmed"],
    ["reserved", "unconfirmed"],
  ];
  expect(report.header.fields).toEqual(
    headerWords.map(([role, status], index) => {
      const offset = index * 4;
      return { offset, value: real.readUInt32LE(offset), role, status };
    }),
  );
  expect(report.payload).toMatchObject({
    offset: 32,
    bytes: real.readUInt32LE(20),
  });
  const limitations = report.limitations.join(" ");
  expect(limitations).toContain("byte-pattern observations");
  expect(limitations).toContain("not source");
  expect(limitations).toContain("View8");
});

it.each([
  [0x20000000, "compile_function"],
  [0x40000000, "module"],
  [0x80000000, "module"],
  [0x60000000, "module"],
] as const)(
  "interprets producer flags %i without changing source length",
  async (flags, producer) => {
    // Older V8 uses bit 31 for modules. A synthetic word with both bits set
    // checks that the module marker wins over the function marker.
    const sourceLength = 19;
    const cache = withHeaderWord(real, 2, flags | sourceLength);
    expect((await parse(cache)).header).toMatchObject({
      producer,
      source_length: sourceLength,
    });
  },
);

it("separates the compileFunction producer bit from the source length", async () => {
  const source = "return 7;";
  const cache = v8FunctionCodeCacheFixture(source);
  const word = cache.readUInt32LE(8);
  const report = await parse(cache);
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

it("fails closed on a foreign magic", async () => {
  const foreign = withHeaderWord(real, 0, 0xdeadbeef);
  await expect(parse(foreign)).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "unsupported",
        format: "v8-code-cache",
      }),
      message: expect.stringContaining("not a V8 code cache"),
    }),
  );
});

it.each([
  V8_CODE_CACHE_LEGACY_HEADER_BYTES - 1,
  V8_CODE_CACHE_NARROW_HEADER_BYTES - 1,
])("fails closed on a header truncated to %i bytes", async (length) => {
  await expect(parse(real.subarray(0, length))).rejects.toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});

it("treats the observed header as version-dependent rather than a fixed ABI", async () => {
  // A producer with a different build constant and version hash is still admitted: only
  // the magic high half and the payload-length relation gate admission.
  const otherBuild = withHeaderWord(
    withHeaderWord(real, 4, 0x4be86e94),
    1,
    0x11111111,
  );
  const report = await parse(otherBuild);
  expect(report.header.fields[1]?.value).toBe(0x11111111);
  expect(report.header.fields[4]?.value).toBe(0x4be86e94);
  expect(report.payload.bytes).toBe(real.readUInt32LE(20));
});

it("fails closed when the declared payload leaves no admitted header size", async () => {
  const oddHeader = Buffer.concat([
    real.subarray(0, V8_CODE_CACHE_NARROW_HEADER_BYTES + 2),
    real.subarray(V8_CODE_CACHE_HEADER_BYTES),
  ]);
  await expect(parse(oddHeader)).rejects.toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});

it("refuses a wide container that is only four bytes short", async () => {
  // Truncating a 32-byte-header cache by four bytes makes `bytes.length - declaredPayload`
  // equal 28. The padding then occupies the same position as a zero first
  // payload word in a narrow container, so the reader refuses the ambiguity.
  const short = real.subarray(0, real.length - 4);
  expect(short.readUInt32LE(28)).toBe(0);
  await expect(parse(short)).rejects.toThrow(
    expect.objectContaining({
      kind: "malformed",
      message: expect.stringContaining("ambiguous"),
    }),
  );
  // A synthetic narrow fixture has payload at the same byte offset.
  const narrow = withSyntheticNarrowHeader(real);
  expect(narrow.readUInt32LE(V8_CODE_CACHE_NARROW_HEADER_BYTES)).not.toBe(0);
  expect((await parse(narrow)).header.header_bytes).toBe(
    V8_CODE_CACHE_NARROW_HEADER_BYTES,
  );
});

it("reports older module flags and confidence in a synthetic six-word header", async () => {
  const legacy = withSyntheticLegacyHeader(withHeaderWord(real, 2, 0x80000017));
  const report = await parse(legacy);
  expect(report.header).toMatchObject({
    header_bytes: V8_CODE_CACHE_LEGACY_HEADER_BYTES,
    source_length: 23,
    producer: "module",
    fields: [
      { offset: 0, role: "magic", status: "confirmed" },
      { offset: 4, role: "version_hash", status: "inferred" },
      { offset: 8, role: "source_length", status: "inferred" },
      { offset: 12, role: "flag_hash", status: "inferred" },
      { offset: 16, role: "payload_length", status: "confirmed" },
      { offset: 20, role: "reserved", status: "unconfirmed" },
    ],
  });
  for (const field of report.header.fields)
    expect(field.value).toBe(legacy.readUInt32LE(field.offset));
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("not measured against one of their producers"),
    ]),
  );
});

it("refuses a six-word container that lost its last payload word", async () => {
  const legacy = withSyntheticLegacyHeader(real);
  await expect(parse(legacy.subarray(0, legacy.length - 4))).rejects.toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});

it("refuses a container whose payload length fits both layouts", async () => {
  // The six-word layout does not constrain the word after its payload length,
  // so that word can also reach the end of the file from a 28-byte header.
  // Nothing in the header separates the two readings.
  const legacy = withSyntheticLegacyHeader(real);
  const both = withHeaderWord(
    legacy,
    5,
    legacy.length - V8_CODE_CACHE_NARROW_HEADER_BYTES,
  );
  await expect(parse(both)).rejects.toThrow(
    expect.objectContaining({
      kind: "malformed",
      message: expect.stringContaining("ambiguous"),
    }),
  );
});

it("rejects contradictory retained word tables and payload coordinates", async () => {
  const report = await parse(withSyntheticNarrowHeader(real));
  const fields = report.header.fields;
  const short = { ...report.header, fields: fields.slice(0, -1) };
  const long = {
    ...report.header,
    fields: [...fields, { ...fields.at(-1)!, offset: 28 }],
  };
  const duplicateFirstOffset = { ...fields[0]!, offset: 4 };
  const disordered = {
    ...report.header,
    fields: [duplicateFirstOffset, ...fields.slice(1)],
  };
  for (const header of [short, long, disordered]) {
    expect(
      v8CodeCacheSchema.safeParse({ ...report, header }).error?.issues,
    ).toContainEqual(expect.objectContaining({ path: ["header", "fields"] }));
  }
  const shiftedPayload = {
    ...report,
    artifact: { ...report.artifact, bytes: report.artifact.bytes + 4 },
    payload: { ...report.payload, offset: report.payload.offset + 4 },
  };
  expect(
    v8CodeCacheSchema.safeParse(shiftedPayload).error?.issues,
  ).toContainEqual(expect.objectContaining({ path: ["payload", "offset"] }));
});

it("observes exact printable runs across positional read boundaries and at EOF", async () => {
  const prefixEnd = 65_536;
  const chunkEnd = prefixEnd + 1024 * 1024;
  const bytes = Buffer.alloc(chunkEnd + 8192);
  real.copy(bytes, 0, 0, 32);
  bytes.writeUInt32LE(bytes.length - 32, 20);

  const longLength = MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES + 64;
  bytes.write("prefix	boundary", prefixEnd - 8, "ascii");
  bytes.write("ignored", prefixEnd + 25, "ascii");
  bytes.fill(0x61, chunkEnd - 100, chunkEnd - 100 + longLength);
  bytes.write("at the end", bytes.length - 10, "ascii");
  const reads: [number, number][] = [];
  const report = v8CodeCacheSchema.parse(
    await parseV8CodeCacheFromHandle(
      {
        size: bytes.length,
        prefix: bytes.subarray(0, prefixEnd),
        readRange: async (offset, length) => {
          reads.push([offset, length]);
          return bytes.subarray(offset, offset + length);
        },
      },
      identity(bytes),
      { ...defaults, min_string_bytes: 8 },
    ),
  );
  expect(reads).toEqual([
    [prefixEnd, chunkEnd - prefixEnd],
    [chunkEnd, 8192],
  ]);
  expect(report.payload).toEqual({
    offset: 32,
    bytes: bytes.length - 32,
    sha256: createHash("sha256").update(bytes.subarray(32)).digest("hex"),
    trailing_bytes: 0,
  });
  expect(report.coverage).toEqual({
    status: "complete",
    scanned_bytes: bytes.length - 32,
    strings: 3,
  });
  expect(report.embedded_strings).toEqual([
    {
      offset: prefixEnd - 8,
      bytes: 15,
      retained_bytes: 15,
      text: "prefix	boundary",
      truncated: false,
    },
    {
      offset: chunkEnd - 100,
      bytes: 4160,
      retained_bytes: 4096,
      text: "a".repeat(4096),
      truncated: true,
    },
    {
      offset: bytes.length - 10,
      bytes: 10,
      retained_bytes: 10,
      text: "at the end",
      truncated: false,
    },
  ]);
});
