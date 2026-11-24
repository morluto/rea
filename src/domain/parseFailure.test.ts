import { inflateRawSync, deflateRawSync } from "node:zlib";

import { expect, it } from "vitest";

import {
  hostRangeErrorKind,
  isHostLimitFailure,
  malformedInput,
  parseFailureFromCause,
} from "./parseFailure.js";

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected the host to throw");
};

const recurse = (depth: number): number => recurse(depth + 1) + 1;

const stackOverflow = thrown(() => recurse(0));
const bufferPastEnd = thrown(() => Buffer.alloc(4).readUInt32LE(2));
const dataViewPastEnd = thrown(() =>
  new DataView(new ArrayBuffer(2)).getUint32(0),
);
const inflatePastBound = thrown(() =>
  inflateRawSync(deflateRawSync(Buffer.alloc(4096)), { maxOutputLength: 16 }),
);

it.each([
  ["a call stack overflow", stackOverflow, "stack-overflow"],
  ["an output past its allocation bound", inflatePastBound, "host-capacity"],
  [
    "an over-long string",
    new RangeError("Invalid string length"),
    "host-capacity",
  ],
  ["a Buffer read past its end", bufferPastEnd, undefined],
  ["a DataView read past its end", dataViewPastEnd, undefined],
  ["an invalid allocation", thrown(() => Buffer.alloc(-1)), undefined],
  [
    "an invalid write value",
    thrown(() => Buffer.alloc(1).writeUInt8(256)),
    undefined,
  ],
  [
    "a write past its end",
    thrown(() => Buffer.alloc(4).writeUInt32LE(1, 2)),
    undefined,
  ],
  [
    "a RangeError REA threw itself",
    new RangeError("Truncated header"),
    undefined,
  ],
  ["an unrelated error", new TypeError("not a range"), undefined],
] as const)("classifies %s", (_label, cause, kind) => {
  expect(hostRangeErrorKind(cause)).toBe(kind);
  expect(parseFailureFromCause(cause)).toBeUndefined();
  expect(isHostLimitFailure(cause)).toBe(
    kind === "stack-overflow" || kind === "host-capacity",
  );
});

it("preserves an explicitly reported format failure", () => {
  const reported = malformedInput("macho", "load command leaves the header");
  expect(parseFailureFromCause(reported)).toBe(reported);
});

it.each([stackOverflow, inflatePastBound, new RangeError("Truncated header")])(
  "leaves a host failure or an unclassified RangeError to the caller (%s)",
  (cause) => {
    expect(parseFailureFromCause(cause)).toBeUndefined();
  },
);
