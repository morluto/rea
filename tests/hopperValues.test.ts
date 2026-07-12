import { describe, expect, it } from "vitest";

import {
  parseDocuments,
  parseListCount,
  parseNames,
  parseProcedures,
  parseRelatedAddresses,
  parseSegments,
} from "../src/domain/hopperValues.js";

describe("Hopper boundary values", () => {
  it("parses Hopper's address-keyed name and string maps", () => {
    expect(parseNames({ "0x1000": "_main" })).toEqual({
      ok: true,
      value: [{ address: "0x1000", name: "_main" }],
    });
    expect(
      parseListCount({ "0x1000": "hello", "0x2000": "world" }, "strings"),
    ).toEqual({ ok: true, value: 2 });
  });

  it("parses direct and wrapped protocol shapes", () => {
    expect(parseProcedures({ procedures: { "0x1": "main" } })).toEqual({
      ok: true,
      value: [{ address: "0x1", name: "main" }],
    });
    expect(parseNames({ names: [{ address: "0x2", name: "label" }] }).ok).toBe(
      true,
    );
    expect(parseRelatedAddresses({ callers: ["0x3"] }, "callers")).toEqual({
      ok: true,
      value: ["0x3"],
    });
    expect(
      parseSegments([
        {
          name: "__TEXT",
          start: "0x1",
          end: "0x2",
          readable: true,
          writable: false,
          executable: null,
        },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "__TEXT",
          start: "0x1",
          end: "0x2",
          readable: true,
          writable: false,
          executable: null,
        },
      ],
    });
    expect(parseDocuments(["fixture"])).toEqual({
      ok: true,
      value: ["fixture"],
    });
  });

  it.each([
    ["procedures", () => parseProcedures(["not-a-map"])],
    ["names", () => parseNames([{ address: 1, name: "bad" }])],
    ["relations", () => parseRelatedAddresses([1], "callees")],
    ["segments", () => parseSegments([{ name: 1 }])],
    ["documents", () => parseDocuments([1])],
  ])(
    "rejects malformed %s instead of manufacturing empty output",
    (_label, parse) => {
      const result = parse();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("HopperProtocolError");
    },
  );
});
