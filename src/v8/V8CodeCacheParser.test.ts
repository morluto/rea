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
  // An unflagged word is `unknown`, not `script`: a `vm.compileFunction` cache from a
  // build that does not mark bit 29 reads the same as a script, so the container alone
  // cannot separate them. The observed word stays available in `header.fields`.
  expect(report.header.producer).toBe("unknown");
  expect(report.header.fields[2]?.value).toBe(cache.readUInt32LE(8));
});

it("reports a module cache as a module rather than a script", () => {
  // Bit 30 of the source-length word marks `vm.SourceTextModule` output. Measured on
  // Node 24.22.1: a real module cache reads `0x40000013` for a 19-unit source while a
  // script of the same length reads `0x00000013`, so a producer check that only tests
  // the function bit reports the module cache as a plain script.
  const script = v8CodeCacheFixture();
  const word = script.readUInt32LE(8);
  const length = word & 0x1fffffff;
  expect(word & 0x40000000).toBe(0);
  expect(word & 0x20000000).toBe(0);
  expect(parse(script).header.producer).toBe("unknown");

  const moduleCache = withHeaderWord(script, 2, word | 0x40000000);
  const report = parse(moduleCache);
  expect(report.header.producer).toBe("module");
  // The module bit sits outside the source-length mask, so the length is unchanged.
  expect(report.header.source_length).toBe(length);
});

it("keeps the function and module flags distinct", () => {
  const script = v8CodeCacheFixture("var y = 1;");
  const length = script.readUInt32LE(8) & 0x1fffffff;
  expect(
    parse(withHeaderWord(script, 2, 0x20000000 | length)).header.producer,
  ).toBe("compile_function");
  expect(
    parse(withHeaderWord(script, 2, 0x40000000 | length)).header.producer,
  ).toBe("module");
  // V8 before 13.4 (Node 22's 12.4) marks a module with bit 31: `0x80000017` on Electron 30.
  const legacy = parse(withHeaderWord(script, 2, 0x80000000 | length)).header;
  expect([legacy.producer, legacy.source_length]).toEqual(["module", length]);
  // Both bits set is not a shape V8 produces; the module flag wins so the reported
  // family stays one of the three observed kinds.
  expect(
    parse(withHeaderWord(script, 2, 0x60000000 | length)).header.producer,
  ).toBe("module");
});

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
  expect(report.header.source_length).toBe(word & 0x1fffffff);
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
