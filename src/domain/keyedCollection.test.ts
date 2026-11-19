import { describe, expect, it } from "vitest";

import {
  allKeyed,
  firstKeyed,
  keyedBy,
  uniqueKeyed,
} from "./keyedCollection.js";

const sections = [
  { name: "__text", id: 0 },
  { name: null, id: 1 },
  { name: "__data", id: 2 },
  { name: "__text", id: 3 },
];

describe("keyed collections", () => {
  const keyed = keyedBy(sections, ({ name }) => name);

  it("retains every keyed declaration in source order and names repeats", () => {
    expect(keyed.entries.map(({ key, ordinal }) => [key, ordinal])).toEqual([
      ["__text", 0],
      ["__data", 1],
      ["__text", 2],
    ]);
    expect(keyed.duplicates).toEqual(["__text"]);
  });

  it("selects a single declaration, or nothing when absent", () => {
    expect(uniqueKeyed(keyed, "__data")).toEqual({
      ok: true,
      value: sections[2],
    });
    expect(uniqueKeyed(keyed, "__bss")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("refuses to choose among repeated declarations", () => {
    expect(uniqueKeyed(keyed, "__text")).toEqual({
      ok: false,
      error: { kind: "duplicate", key: "__text", ordinals: [0, 2] },
    });
  });
});

describe("keyed precedence and repeated keys", () => {
  const byType = keyedBy(
    [
      { type: 11, id: 0 },
      { type: 2, id: 1 },
      { type: 11, id: 2 },
    ],
    ({ type }) => type,
  );

  it("keys by a numeric tag and lists every declaration", () => {
    expect(byType.duplicates).toEqual([11]);
    expect(allKeyed(byType, 11).map(({ id }) => id)).toEqual([0, 2]);
    expect(allKeyed(byType, 3)).toEqual([]);
  });

  it("requires callers to state the format's precedence rule", () => {
    expect(() => firstKeyed(byType, 11, " ")).toThrow(TypeError);
  });
});
