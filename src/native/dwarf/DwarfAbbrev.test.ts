import { describe, expect, it } from "vitest";
import { MAX_DWARF_ABBREV_ENTRIES } from "../../domain/native/dwarfUnits.js";
import { DwarfAbbrevCache } from "./DwarfAbbrev.js";
import { abbrevTable, uleb } from "./DwarfUnits.fixture.js";

const cache = (bytes: Buffer) => new DwarfAbbrevCache(bytes, true);

describe("DWARF abbreviation tables", () => {
  it("parses implicit_const and caches the table", () => {
    const bytes = abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [{ name: 0x13, form: 0x21, implicit: 0x1c }],
      },
    ]);
    const table = cache(bytes);
    const first = table.get(0);
    expect(first).toBe(table.get(0));
    expect(first).toMatchObject({ kind: "ok" });
    if (first.kind !== "ok") return;
    expect(first.entries.get(1)?.attributes[0]).toMatchObject({
      name: 0x13,
      form: 0x21,
      implicit: 28n,
    });
  });

  it("rejects a duplicate code, a children flag other than 0 or 1, and an offset past the section", () => {
    const entry = Buffer.concat([
      uleb(7),
      uleb(0x11),
      Buffer.from([0]),
      uleb(0),
      uleb(0),
    ]);
    const duplicate = Buffer.concat([
      entry,
      uleb(7),
      uleb(0x11),
      Buffer.from([0]),
    ]);
    expect(cache(duplicate).get(0)).toMatchObject({
      kind: "malformed",
      message: "Duplicate abbreviation code 7",
    });
    const children = Buffer.concat([uleb(1), uleb(0x11), Buffer.from([2])]);
    expect(cache(children).get(0)).toMatchObject({
      kind: "malformed",
      message: "Abbreviation children flag is not 0 or 1",
    });
    expect(cache(Buffer.from([0])).get(4)).toMatchObject({
      kind: "malformed",
      message: "Abbreviation offset is outside .debug_abbrev",
    });
  });

  it("stops at the abbreviation entry budget", () => {
    const entries = Array.from(
      { length: MAX_DWARF_ABBREV_ENTRIES + 1 },
      (_, index) =>
        Buffer.concat([
          uleb(index + 1),
          uleb(0x11),
          Buffer.from([0]),
          uleb(0),
          uleb(0),
        ]),
    );
    const parsed = cache(Buffer.concat(entries)).get(0);
    expect(parsed.kind).toBe("budget");
  });

  it("applies the entry budget per table and evicts instead of refusing a later table", () => {
    const full = abbrevTable(
      Array.from({ length: MAX_DWARF_ABBREV_ENTRIES }, (_, index) => ({
        code: index + 1,
        tag: 0x11,
        children: false,
        attributes: [],
      })),
    );
    const next = abbrevTable([
      { code: 1, tag: 0x11, children: false, attributes: [] },
    ]);
    const tables = cache(Buffer.concat([full, next]));
    const first = tables.get(0);
    expect(first.kind).toBe("ok");
    const second = tables.get(full.length);
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") expect(second.entries.size).toBe(1);
    expect(tables.get(0)).not.toBe(first);
    expect(tables.get(0)).toEqual(first);
  });

  it("recognizes a section that holds exactly one table", () => {
    const table = abbrevTable([
      { code: 1, tag: 0x11, children: false, attributes: [] },
    ]);
    expect(cache(table).holdsOneTable()).toBe(true);
    expect(cache(Buffer.concat([table, table])).holdsOneTable()).toBe(false);
    expect(cache(Buffer.from([1])).holdsOneTable()).toBe(false);
  });

  it("bounds aggregate parsing work when overlapping tables evict each other", () => {
    const full = abbrevTable(
      Array.from({ length: MAX_DWARF_ABBREV_ENTRIES }, (_, index) => ({
        code: index + 1,
        tag: 0x11,
        children: false,
        attributes: [],
      })),
    );
    const tables = cache(full);
    const secondOffset = 5; // First entry: code, tag, children, and two zeroes.
    expect(tables.get(0).kind).toBe("ok");
    let exhausted = false;
    for (let index = 0; index < 256; index += 1) {
      const offset = index % 2 === 0 ? secondOffset : 0;
      const result = tables.get(offset);
      if (result.kind === "budget") {
        expect(result.message).toContain("aggregate parsing work allowance");
        expect(tables.get(offset)).toBe(result);
        exhausted = true;
        break;
      }
      expect(result.kind).toBe("ok");
    }
    expect(exhausted).toBe(true);
  });
});
