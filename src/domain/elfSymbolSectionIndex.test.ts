import { expect, it } from "vitest";
import {
  ELF_SHN_XINDEX,
  ElfSymbolSectionIndexTables,
  readElfSymbolSectionReference,
} from "./elfSymbolSectionIndex.js";

const layout = (overrides = {}) => ({
  type: 18,
  link: 3,
  size: 8n,
  entry_size: 4n,
  file_backed: true,
  compressed: false,
  ...overrides,
});

it.each([true, false])(
  "resolves extended indices in the ELF byte order (little=%s)",
  (little) => {
    for (const index of [0xff00, 0xfff1, 0xffff, 0x10000]) {
      const carrier = new Uint8Array(24);
      const bytes = carrier.subarray(7, 15);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
        4,
        index,
        little,
      );
      expect(
        readElfSymbolSectionReference(
          ELF_SHN_XINDEX,
          1,
          0x10001,
          little,
          bytes,
        ),
      ).toEqual({
        ok: true,
        value: { kind: "section", index },
      });
    }
  },
);

it("keeps raw special indices distinct from ordinary and extended sections", () => {
  for (const [raw, kind] of [
    [0, "undefined"],
    [0xfff1, "absolute"],
    [0xfff2, "common"],
  ] as const)
    expect(readElfSymbolSectionReference(raw, 1, 0x10001, true)).toEqual({
      ok: true,
      value: { kind },
    });
  expect(readElfSymbolSectionReference(0xff00, 1, 0x10001, true)).toEqual({
    ok: true,
    value: { kind: "reserved", index: 0xff00 },
  });
  expect(
    readElfSymbolSectionReference(1, 1, 2, true, new Uint8Array()),
  ).toEqual({
    ok: true,
    value: { kind: "section", index: 1 },
  });
  expect(readElfSymbolSectionReference(2, 1, 2, true).ok).toBe(false);
});

it("does not invent a section when the companion entry is missing or invalid", () => {
  expect(readElfSymbolSectionReference(ELF_SHN_XINDEX, 1, 70000, true).ok).toBe(
    false,
  );
  expect(
    readElfSymbolSectionReference(
      ELF_SHN_XINDEX,
      1,
      70000,
      true,
      new Uint8Array(7),
    ).ok,
  ).toBe(false);
  for (const index of [0, 70000, 0xffffffff]) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(4, index, true);
    expect(
      readElfSymbolSectionReference(ELF_SHN_XINDEX, 1, 70000, true, bytes).ok,
    ).toBe(false);
  }
});

it("selects the uniquely linked companion and checks its complete declared extent", () => {
  const unrelated = layout({ link: 9 });
  const selected = layout();
  const tables = new ElfSymbolSectionIndexTables([unrelated, selected]);
  expect(tables.tableFor(3, 2n)).toEqual({ ok: true, value: selected });
  expect(tables.tableFor(4, 2n).ok).toBe(false);
  expect(tables.tableFor(3, 3n).ok).toBe(false);
  expect(
    new ElfSymbolSectionIndexTables([selected, selected]).tableFor(3, 2n).ok,
  ).toBe(false);
  for (const invalid of [
    { size: 7n },
    { size: 12n },
    { entry_size: 0n },
    { entry_size: 8n },
    { file_backed: false },
    { compressed: true },
  ])
    expect(
      new ElfSymbolSectionIndexTables([layout(invalid)]).tableFor(3, 2n).ok,
    ).toBe(false);
});
