import { expect, it } from "vitest";
import {
  BinaryFormatFailure,
  BinaryStringReadLimitFailure,
} from "./BinaryContainer.js";
import { readElfString, readElfStringBytes } from "./ElfStringTable.js";

it("preserves empty and non-UTF8 string-table bytes", () => {
  const table = Buffer.from([0, 0xff, 0x61, 0]);
  expect(readElfStringBytes(table, 0).equals(Buffer.alloc(0))).toBe(true);
  expect(readElfStringBytes(table, 1).equals(Buffer.from([0xff, 0x61]))).toBe(
    true,
  );
  expect(readElfString(table, 1)).toBe("\xffa");
});

it("reads a terminator inside the scan allowance at a nonzero table offset", () => {
  const table = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(65_535, 0x61),
    Buffer.from([0]),
  ]);
  expect(readElfStringBytes(table, 1)).toHaveLength(65_535);
});

it.each([65_536, 70_000])(
  "reports unknown termination when a %i-byte string exceeds the scan allowance",
  (size) => {
    const table = Buffer.concat([
      Buffer.from([0]),
      Buffer.alloc(size, 0x61),
      Buffer.from([0]),
    ]);
    let failure: unknown;
    try {
      readElfStringBytes(table, 1);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(BinaryStringReadLimitFailure);
    expect(failure).toBeInstanceOf(BinaryFormatFailure);
    expect(failure).toMatchObject({ maximumBytes: 65_536 });
  },
);

it.each([3, 65_536])(
  "keeps a fully examined %i-byte unterminated table malformed",
  (size) => {
    const table = Buffer.alloc(size, 0x61);
    expect(() => readElfStringBytes(table, 0)).toThrow(BinaryFormatFailure);
    expect(() => readElfStringBytes(table, 0)).not.toThrow(
      BinaryStringReadLimitFailure,
    );
  },
);

it.each([-1, 1])("keeps an out-of-table offset %i malformed", (offset) => {
  expect(() => readElfStringBytes(Buffer.from([0]), offset)).toThrow(
    BinaryFormatFailure,
  );
  expect(() => readElfStringBytes(Buffer.from([0]), offset)).not.toThrow(
    BinaryStringReadLimitFailure,
  );
});
