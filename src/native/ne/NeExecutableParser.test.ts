import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectNeExecutableInputSchema,
  neExecutableSchema,
} from "../../domain/native/neExecutable.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { parseNeExecutable } from "./NeExecutableParser.js";
import { neFixture } from "./NeExecutable.fixture.js";

const parse = (bytes: Buffer, maxRows = 4096, signal?: AbortSignal) =>
  parseNeExecutable(
    bytes,
    {
      path: "/fixtures/sample.dll",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectNeExecutableInputSchema.parse({
      path: "/fixtures/sample.dll",
      max_rows: maxRows,
    }),
    signal,
  );

const rejection = async (bytes: Buffer, maxRows?: number) => {
  const failure = await parse(bytes, maxRows).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(ParseFailureError);
  return failure as ParseFailureError;
};

/** A structural refusal: the bytes are not a well-formed NE image. */
const expectFormatFailure = (failure: ParseFailureError) => {
  expect(failure.failure.format).toBe("ne");
  expect(["malformed", "truncated"]).toContain(failure.kind);
};

type Fixture = ReturnType<typeof neFixture>;
const CORRUPTIONS: readonly (readonly [
  string,
  (bytes: Buffer, ne: number, fixture: Fixture) => void,
])[] = [
  [
    "a non-NE image",
    (bytes: Buffer, at: number) => bytes.write("PE", at, "latin1"),
  ],
  [
    "a truncated header",
    (bytes: Buffer) => {
      bytes.writeUInt32LE(bytes.length - 8, 0x3c);
      bytes.write("NE", bytes.length - 8, "latin1");
    },
  ],
  [
    "a segment table outside the file",
    (bytes: Buffer, at: number) => bytes.writeUInt16LE(0xfff0, at + 0x22),
  ],
  [
    "a resource leaving the file",
    (bytes: Buffer, _at: number, fixture: Fixture) =>
      bytes.writeUInt16LE(0xffff, fixture.resourceTable + 12),
  ],
  [
    "an entry bundle overrunning its table",
    (bytes: Buffer, at: number) => bytes.writeUInt16LE(4, at + 0x06),
  ],
  [
    "a movable entry without its INT 3Fh thunk",
    (bytes: Buffer, _at: number, fixture: Fixture) => {
      bytes[fixture.entryTable + 13] = 0x90;
    },
  ],
  [
    "a module reference outside the file",
    (bytes: Buffer, _at: number, fixture: Fixture) =>
      bytes.writeUInt16LE(0xfff0, fixture.moduleReferences),
  ],
  [
    "an unterminated resident name table",
    (bytes: Buffer, at: number) =>
      bytes.writeUInt16LE(bytes.length - at - 1, at + 0x26),
  ],
];

describe("portable NE executable inventory", () => {
  it("reports the header, segments, resources, names, references and entries at their file locations", async () => {
    const fixture = neFixture();
    const result = neExecutableSchema.parse(await parse(fixture.bytes));

    expect(result.format).toBe("ne");
    expect(result.header).toEqual({
      location: { offset: fixture.ne, bytes: 0x40 },
      linker_version: { major: 5, minor: 10 },
      checksum: 0x12345678,
      flags: 0x8002,
      module_kind: "library",
      auto_data_segment: 2,
      heap_bytes: 0x400,
      stack_bytes: 0,
      entry_point: { segment: 1, offset: 0x10 },
      initial_stack: { segment: 0, offset: 0 },
      alignment_shift: 4,
      target_os: 2,
      other_flags: 0,
      expected_windows_version: { major: 3, minor: 0 },
    });
    expect(result.module_name).toEqual({
      name: "SAMPLE",
      location: { offset: fixture.residentNames, bytes: 9 },
    });
    expect(result.description?.name).toBe("Sample library");

    expect(result.segments).toEqual([
      {
        index: 1,
        kind: "code",
        flags: 0x0110,
        location: { offset: fixture.codeSegment, bytes: 12 },
        minimum_allocation_bytes: 0x20,
        relocations: {
          count: 2,
          location: { offset: fixture.codeSegment + 12, bytes: 18 },
        },
      },
      {
        index: 2,
        kind: "data",
        flags: 0x0001,
        location: { offset: fixture.dataSegment, bytes: 4 },
        minimum_allocation_bytes: 0x10000,
        relocations: null,
      },
    ]);

    expect(result.resources).toEqual([
      {
        type: { kind: "id", id: 3 },
        name: { kind: "id", id: 1 },
        flags: 0x0030,
        location: { offset: fixture.iconResource, bytes: 32 },
        entry_location: { offset: fixture.resourceTable + 10, bytes: 12 },
      },
      {
        type: {
          kind: "name",
          name: "CUSTOM",
          location: { offset: fixture.resourceTable + 44, bytes: 7 },
        },
        name: {
          kind: "name",
          name: "HELLO",
          location: { offset: fixture.resourceTable + 51, bytes: 6 },
        },
        flags: 0x0010,
        location: { offset: fixture.customResource, bytes: 16 },
        entry_location: { offset: fixture.resourceTable + 30, bytes: 12 },
      },
    ]);

    expect(result.resident_names).toEqual([
      {
        name: "ENTRYONE",
        ordinal: 1,
        location: { offset: fixture.residentNames + 9, bytes: 11 },
      },
    ]);
    expect(
      result.nonresident_names.map(({ name, ordinal }) => [name, ordinal]),
    ).toEqual([["HIDDENFN", 2]]);
    expect(result.module_references).toEqual([
      {
        index: 1,
        name: "KERNEL",
        location: { offset: fixture.importedNames + 1, bytes: 7 },
      },
      {
        index: 2,
        name: "USER",
        location: { offset: fixture.importedNames + 8, bytes: 5 },
      },
    ]);
    expect(result.entries).toEqual([
      {
        ordinal: 1,
        movable: false,
        segment: 1,
        offset: 0x10,
        flags: 0x01,
        location: { offset: fixture.entryTable + 2, bytes: 3 },
      },
      {
        ordinal: 2,
        movable: false,
        segment: 1,
        offset: 0x20,
        flags: 0x00,
        location: { offset: fixture.entryTable + 5, bytes: 3 },
      },
      {
        ordinal: 4,
        movable: true,
        segment: 2,
        offset: 0x1234,
        flags: 0x03,
        location: { offset: fixture.entryTable + 12, bytes: 6 },
      },
    ]);
    expect(result.coverage).toEqual({ status: "complete", examined_rows: 13 });
  });
});

describe("portable NE executable parsing edge cases", () => {
  it("decodes names byte-for-byte as latin1", async () => {
    const fixture = neFixture();
    fixture.bytes[fixture.residentNames + 1] = 0xe9;
    const result = await parse(fixture.bytes);
    expect(result.module_name?.name).toBe("éAMPLE");
  });

  it("reports a segment without file data and a 64 KiB zero-length segment", async () => {
    const fixture = neFixture();
    fixture.bytes.writeUInt16LE(0, fixture.segmentTable + 8);
    const result = await parse(fixture.bytes);
    expect(result.segments[1]?.location).toBeNull();

    const sized = neFixture();
    sized.bytes.writeUInt16LE(0, sized.segmentTable + 2);
    const failure = await rejection(sized.bytes);
    expectFormatFailure(failure);
    expect(failure.message).toMatch(/segment 1/);
  });

  it.each(CORRUPTIONS)(
    "rejects %s without partial success",
    async (_label, corrupt) => {
      const fixture = neFixture();
      corrupt(fixture.bytes, fixture.ne, fixture);
      expectFormatFailure(await rejection(fixture.bytes));
    },
  );

  it("fails the row budget without partial success", async () => {
    const failure = await rejection(neFixture().bytes, 12);
    expect(failure.failure).toMatchObject({
      kind: "limit",
      format: "ne",
      limit: { name: "max_rows", maximum: 12 },
    });
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parse(neFixture().bytes, 4096, controller.signal),
    ).rejects.toThrow();
  });
});
