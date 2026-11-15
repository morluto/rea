import { expect, it } from "vitest";

import { InternalInvariantError } from "../../domain/internalInvariant.js";
import { FieldReader } from "./AppleIpsFieldReader.js";

it("adds integers recorded by the same reader", () => {
  const read = new FieldReader(1024);
  expect(
    read.add(read.recordedInteger("40"), read.recordedInteger("2")),
  ).toEqual({ decimal: "42", hex: "0x2a" });
});

// Recorded integers come only from REA's own parser, so a fact from another
// reader is a REA defect rather than a malformed crash report.
it("reports another reader's integer fact as a broken internal assumption", () => {
  const read = new FieldReader(1024);
  const foreign = new FieldReader(1024).recordedInteger("2");
  expect(() => read.add(read.recordedInteger("40"), foreign)).toThrow(
    InternalInvariantError,
  );
});
