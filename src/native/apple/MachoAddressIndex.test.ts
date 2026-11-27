import { describe, expect, it } from "vitest";
import {
  indexCoveredRanges,
  indexFileOffsets,
  indexSmallestSections,
  lookupInterval,
  type SectionSpan,
} from "./MachoAddressIndex.js";

const span = (name: string, address: bigint, size: bigint): SectionSpan => ({
  name,
  address,
  size,
});

/** The linear scan the index replaces: smallest wins, first declared on ties. */
const scanSmallest = (
  sections: readonly SectionSpan[],
  address: bigint,
): string | null => {
  let best: SectionSpan | null = null;
  for (const section of sections) {
    if (address < section.address || address >= section.address + section.size)
      continue;
    if (best === null || section.size < best.size) best = section;
  }
  return best?.name ?? null;
};

describe("indexSmallestSections", () => {
  it("matches a linear scan over nested, overlapping, tied and empty sections", () => {
    const sections = [
      span("outer", 0x1000n, 0x1000n),
      span("inner", 0x1200n, 0x100n),
      span("overlap", 0x1280n, 0x200n),
      span("tie-first", 0x3000n, 0x10n),
      span("tie-second", 0x3000n, 0x10n),
      span("empty", 0x1250n, 0n),
      span("later-smaller", 0x1290n, 0x8n),
    ];
    const index = indexSmallestSections(sections);
    for (let address = 0xff0n; address < 0x3020n; address += 1n) {
      expect(
        lookupInterval(index, address)?.name ?? null,
        `0x${address.toString(16)}`,
      ).toBe(scanSmallest(sections, address));
    }
  });

  it("returns nothing when no section is declared", () => {
    expect(lookupInterval(indexSmallestSections([]), 0n)).toBeUndefined();
  });
});

describe("indexFileOffsets", () => {
  it("translates offsets and treats conflicting translations as ambiguous", () => {
    const index = indexFileOffsets([
      { address: 0x100000000n, offset: 0, size: 0x4000 },
      { address: 0x100008000n, offset: 0x4000, size: 0x1000 },
      { address: 0x200000000n, offset: 0x4800, size: 0x1000 },
      { address: 0x100004000n, offset: 0x4000, size: 0 },
    ]);
    const at = (offset: number): bigint | null => {
      const delta = lookupInterval(index, BigInt(offset));
      return delta === undefined || delta === null
        ? null
        : BigInt(offset) + delta;
    };
    expect(at(0x10)).toBe(0x100000010n);
    expect(at(0x4100)).toBe(0x100008100n);
    expect(at(0x4900)).toBeNull();
    expect(at(0x5700)).toBe(0x200000f00n);
    expect(at(0x6000)).toBeNull();
  });

  it("keeps one translation when identical mappings overlap", () => {
    const index = indexFileOffsets([
      { address: 0x1000n, offset: 0, size: 0x100 },
      { address: 0x1080n, offset: 0x80, size: 0x100 },
    ]);
    expect(lookupInterval(index, 0x90n)).toBe(0x1000n);
  });
});

describe("indexCoveredRanges", () => {
  it("matches a linear scan over overlapping, adjacent, empty and disjoint ranges", () => {
    const ranges = [
      { address: 0x1000n, size: 0x100n },
      { address: 0x1080n, size: 0x100n },
      { address: 0x1180n, size: 0x80n },
      { address: 0x2000n, size: 0n },
      { address: 0x3000n, size: 0x10n },
    ];
    const index = indexCoveredRanges(ranges);
    for (let point = 0xf00n; point < 0x3100n; point += 0x8n) {
      const scanned = ranges.some(
        (range) => point >= range.address && point < range.address + range.size,
      );
      expect(
        lookupInterval(index, point) === true,
        `0x${point.toString(16)}`,
      ).toBe(scanned);
    }
    expect(indexCoveredRanges([])).toEqual({ bounds: [], values: [] });
  });
});
