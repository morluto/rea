import { describe, expect, it } from "vitest";

import {
  admitManagedProjection,
  ManagedDecodeBudget,
} from "./managedDecodeBudget.js";
import { ManagedReaderFailure } from "./managedReaderFailure.js";
import { InternalInvariantError } from "../internalInvariant.js";

describe("managed projection admission", () => {
  it("charges escaped and multibyte strings by their exact JSON byte length", () => {
    for (const text of [
      "plain ASCII",
      "\u0001",
      "€",
      '\u0001"\\€😀\ud800\udc00\ud800',
    ]) {
      const length = Buffer.byteLength(JSON.stringify(text));
      expect(
        admitManagedProjection(text, new ManagedDecodeBudget(length)),
      ).toBe(text);
      expect(() =>
        admitManagedProjection(text, new ManagedDecodeBudget(length - 1)),
      ).toThrow(ManagedReaderFailure);
    }
  });

  it("spends a record's prepaid charge once across and within containing projections", () => {
    const record = { name: "a".repeat(60) };
    const budget = new ManagedDecodeBudget(120);
    admitManagedProjection(record, budget);

    // The first containing projection can spend the credit. A fresh containing
    // projection must charge the record again.
    expect(admitManagedProjection({ records: [record] }, budget)).toEqual({
      records: [record],
    });
    expect(() => admitManagedProjection({ records: [record] }, budget)).toThrow(
      ManagedReaderFailure,
    );

    // Two appearances in one result also consume one credit, then pay again.
    const repeated = new ManagedDecodeBudget(120);
    admitManagedProjection(record, repeated);
    expect(() =>
      admitManagedProjection({ records: [record, record] }, repeated),
    ).toThrow(ManagedReaderFailure);
  });
});

describe("managed decoding bounds", () => {
  it("bounds new row identities without charging lookup replay or merging tables", () => {
    const budget = new ManagedDecodeBudget();
    budget.reserve(64 * 1024 * 1024 - 512, null);
    budget.reserveRow(2, 1, 100);
    budget.reserveRow(12, 1, 200);

    expect(() => budget.reserveRow(2, 1, 100)).not.toThrow();
    expect(() => budget.reserveRow(2, 2, 300)).toThrow(ManagedReaderFailure);
    // A rejected row has no retained reservation; replay cannot bypass capacity.
    expect(() => budget.reserveRow(2, 2, 300)).toThrow(ManagedReaderFailure);
  });

  it("keeps concurrent decoding bounds within one budget until released", () => {
    const budget = new ManagedDecodeBudget();
    const bound = 40 * 1024 * 1024;

    budget.admitTransient(bound, null);
    expect(() => budget.admitTransient(bound, null)).toThrow(
      ManagedReaderFailure,
    );
    expect(() => budget.reserve(bound, null)).toThrow(ManagedReaderFailure);
    budget.releaseTransient();
    expect(() => budget.admitTransient(bound, null)).not.toThrow();
  });
});

// Callers admit these allowances through their input schemas, so a value
// outside them is a REA defect rather than a malformed target.
it.each([0, -1, 1.5])(
  "reports a %s representation allowance as a broken internal assumption",
  (maximumBytes) => {
    expect(() => new ManagedDecodeBudget(maximumBytes)).toThrow(
      InternalInvariantError,
    );
  },
);
