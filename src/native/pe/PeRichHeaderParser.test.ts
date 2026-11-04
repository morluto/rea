import { describe, expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  inspectPeRichHeaderInputSchema,
  PE_RICH_HEADER_ABSENT_LIMITATION,
  peRichHeaderSchema,
} from "../../domain/native/peRichHeader.js";
import { parsePeRichHeader } from "./PeRichHeaderParser.js";
import {
  peRichHeaderImage,
  RICH_FIXTURE_ENTRIES,
  RICH_FIXTURE_STUB,
  richFixtureBlock,
  richFixtureChecksum,
  type RichFixtureOptions,
} from "./PeRichHeader.fixture.js";

const parseBytes = (bytes: Buffer, max_entries = 1024, signal?: AbortSignal) =>
  parsePeRichHeader(
    bytes,
    { path: "/sample.exe", sha256: "a".repeat(64), bytes: bytes.length },
    inspectPeRichHeaderInputSchema.parse({ path: "/sample.exe", max_entries }),
    signal,
  );

const parse = (options: RichFixtureOptions = {}, max_entries = 1024) =>
  parseBytes(peRichHeaderImage(options), max_entries);

const decoded = RICH_FIXTURE_ENTRIES.map(({ productId, build, count }) => ({
  product_id: productId,
  build,
  count,
}));

describe.each([true, false])("PE32+ %s", (plus) => {
  it("decodes every entry and reproduces the stored key", async () => {
    const report = await parse({ plus });
    expect(peRichHeaderSchema.safeParse(report).success).toBe(true);
    expect(report.format).toBe(plus ? "pe32-plus" : "pe32");
    expect(report.pe_header_offset).toBe(0xb0);
    const key = richFixtureChecksum(
      peRichHeaderImage({ plus }).subarray(0, 0x80),
      RICH_FIXTURE_ENTRIES,
    );
    expect(report.rich_header).toEqual({
      state: "present",
      location: { offset: 0x80, bytes: 16 + 3 * 8 + 8 },
      footer_location: { offset: 0xa8, bytes: 8 },
      key,
      checksum: { computed: key, matches: true },
      padding: [0, 0, 0],
      entries: decoded,
    });
    expect(report.limitations).not.toContain(PE_RICH_HEADER_ABSENT_LIMITATION);
  });
});

it("reports a stored key that the covered bytes do not reproduce", async () => {
  const report = await parse({ key: 0x01020304 });
  expect(report.rich_header).toMatchObject({
    state: "present",
    key: 0x01020304,
    checksum: {
      computed: richFixtureChecksum(
        peRichHeaderImage().subarray(0, 0x80),
        RICH_FIXTURE_ENTRIES,
      ),
      matches: false,
    },
    entries: decoded,
  });
});

it("detects a stub byte changed after linking", async () => {
  const bytes = peRichHeaderImage();
  bytes.writeUInt8(bytes.readUInt8(0x50) ^ 0x01, 0x50);
  const report = await parseBytes(bytes);
  expect(report.rich_header).toMatchObject({
    state: "present",
    checksum: { matches: false },
    entries: decoded,
  });
});

it("reports the decoded padding words as stored", async () => {
  const report = await parse({ padding: [1, 2, 3] });
  expect(report.rich_header).toMatchObject({
    state: "present",
    padding: [1, 2, 3],
    checksum: { matches: true },
  });
});

it("accepts a record with no entries", async () => {
  const report = await parse({ entries: [] });
  expect(report.rich_header).toMatchObject({
    state: "present",
    location: { offset: 0x80, bytes: 24 },
    entries: [],
    checksum: { matches: true },
  });
});

it("reports absence when no footer precedes the PE signature", async () => {
  const report = await parse({ block: false });
  expect(report.rich_header).toEqual({ state: "absent" });
  expect(report.limitations).toContain(PE_RICH_HEADER_ABSENT_LIMITATION);
});

it("ignores a footer whose key would overlap the PE signature", async () => {
  const bytes = peRichHeaderImage({ block: false });
  const pe = bytes.readUInt32LE(0x3c);
  bytes.write("Rich", pe - 4, "latin1");
  expect((await parseBytes(bytes)).rich_header).toEqual({ state: "absent" });
});

it("ignores a Rich marker that is not DWORD aligned", async () => {
  const stub = Buffer.from(RICH_FIXTURE_STUB);
  stub.write("Rich", 0x31, "latin1");
  expect((await parse({ stub, block: false })).rich_header).toEqual({
    state: "absent",
  });
});

it("reads the record before the PE header, not one embedded in the stub", async () => {
  const inner = richFixtureBlock(
    [{ productId: 0x0093, build: 0x7809, count: 2 }],
    0x0badf00d,
  );
  const stub = Buffer.concat([Buffer.alloc(0x40, 0x90), inner]);
  const report = await parse({ stub });
  expect(report.rich_header).toMatchObject({
    state: "present",
    location: { offset: 0x40 + stub.length },
    entries: decoded,
    checksum: { matches: true },
  });
});

it("reports a footer without its DanS marker as malformed", async () => {
  const report = await parse({ omitStart: true });
  expect(report.rich_header).toEqual({
    state: "malformed",
    reason: "start_marker_missing",
    footer_location: { offset: 0xa8, bytes: 8 },
    key: expect.any(Number),
  });
});

it("reports a block that ends inside an entry as malformed", async () => {
  const report = await parse({ extraDword: true });
  expect(report.rich_header).toMatchObject({
    state: "malformed",
    reason: "partial_entry",
    footer_location: { offset: 0xac, bytes: 8 },
  });
});

it("fails closed past the entry budget", async () => {
  const failure = await parse({}, 2).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "limit", boundary: "capacity" });
  await expect(parse({}, 3)).resolves.toMatchObject({
    rich_header: { state: "present" },
  });
});

it("sums a long stub across event-loop yields", async () => {
  const stub = Buffer.alloc(0x200000);
  for (let index = 0; index < stub.length; index++)
    stub[index] = (index * 31) & 0xff;
  const report = await parse({ stub });
  expect(report.rich_header).toMatchObject({
    state: "present",
    location: { offset: 0x40 + stub.length },
    checksum: { matches: true },
  });
});

it("observes cancellation before reading", async () => {
  const controller = new AbortController();
  controller.abort();
  const failure = await parseBytes(
    peRichHeaderImage(),
    1024,
    controller.signal,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ reason: "cancelled" });
});

it("rejects an image without a PE signature", async () => {
  const bytes = peRichHeaderImage();
  bytes.write("ZZ", 0, "latin1");
  const failure = await parseBytes(bytes).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "format" });
});
