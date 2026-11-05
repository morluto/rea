import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectV8CodeCacheInputSchema,
  v8CodeCacheSchema,
  V8_CODE_CACHE_HEADER_BYTES,
  type V8CodeCache,
} from "../domain/v8/v8CodeCache.js";
import { parseV8CodeCache } from "./V8CodeCacheParser.js";
import {
  v8CodeCacheFixture,
  v8FunctionCodeCacheFixture,
  withHeaderWord,
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
  expect(report.header.producer).toBe("script");
});

it("separates the compileFunction producer bit from the source length", () => {
  const source = "return 7;";
  const cache = v8FunctionCodeCacheFixture(source);
  const report = parse(cache);
  expect(report.header.producer).toBe("compile_function");
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
      name: "V8CodeCacheFormatFailure",
      kind: "unsupported",
      message: expect.stringContaining("not a V8 code cache"),
    }),
  );
});

it("fails closed on a payload-length mismatch", () => {
  const corrupt = withHeaderWord(real, 5, real.readUInt32LE(20) + 8);
  expect(() => parse(corrupt)).toThrow(
    expect.objectContaining({
      kind: "malformed",
      message: expect.stringContaining("truncated or corrupt"),
    }),
  );
});

it("fails closed on a truncated header", () => {
  expect(() => parse(real.subarray(0, V8_CODE_CACHE_HEADER_BYTES - 1))).toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});

it("fails closed when fewer payload bytes follow the header than it declares", () => {
  // Cut bytes off the end without rewriting the declared payload length.
  expect(() => parse(real.subarray(0, real.length - 16))).toThrow(
    expect.objectContaining({
      kind: "malformed",
      message: expect.stringContaining("truncated or corrupt"),
    }),
  );
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
      name: "V8CodeCacheBudgetFailure",
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
