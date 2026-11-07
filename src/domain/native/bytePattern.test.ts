import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bytePatternFields,
  validateBytePattern,
  byteSearchResultSchema,
} from "./bytePattern.js";

const patternSchema = z
  .strictObject(bytePatternFields)
  .superRefine(validateBytePattern);

it.each(["0x20", "overlay:0x10", "invalid"])(
  "rejects a match outside reported searched coverage: %s",
  (address) => {
    const page = {
      matches: [
        { address, segment: ".text", file_offset: null, procedure: null },
      ],
      searched: {
        blocks: [{ segment: ".text", start: "0x10", end: "0x1f", bytes: 16 }],
        bytes: 16,
        skipped_uninitialized: [],
        skipped_not_loaded: [],
        skipped_overlay: [],
      },
      complete: true,
      next_cursor: null,
    };
    expect(byteSearchResultSchema.safeParse(page).success).toBe(false);
    page.matches[0]!.address = "0x10";
    expect(byteSearchResultSchema.safeParse(page).success).toBe(true);
    page.matches[0]!.segment = ".bss";
    expect(byteSearchResultSchema.safeParse(page).success).toBe(false);
  },
);

it("reports omitted overlays apart from blocks that are not loaded", () => {
  const page = {
    matches: [],
    searched: {
      blocks: [],
      bytes: 0,
      skipped_uninitialized: [],
      skipped_not_loaded: [
        { segment: ".symtab", start: "0x0", end: "0x17f", bytes: 384 },
      ],
      skipped_overlay: [
        {
          segment: "AUDIT_OVERLAY",
          start: "AUDIT_OVERLAY:0x1000002d8",
          end: "AUDIT_OVERLAY:0x1000002e7",
          bytes: 16,
        },
      ],
    },
    complete: true,
    next_cursor: null,
  };
  expect(byteSearchResultSchema.parse(page).searched).toMatchObject({
    skipped_not_loaded: [{ segment: ".symtab" }],
    skipped_overlay: [{ segment: "AUDIT_OVERLAY", bytes: 16 }],
  });
  // A page that folds overlays into another omission reason is rejected.
  const { skipped_overlay: _omitted, ...folded } = page.searched;
  expect(
    byteSearchResultSchema.safeParse({ ...page, searched: folded }).success,
  ).toBe(false);
});

it.each(["", "overlay:"])(
  "accepts matches at both inclusive coverage boundaries in address space %s",
  (space) => {
    const start = `${space}0x10`;
    const end = `${space}0x1f`;
    expect(
      byteSearchResultSchema.safeParse({
        matches: [start, end].map((address) => ({
          address,
          segment: ".text",
          file_offset: null,
          procedure: null,
        })),
        searched: {
          blocks: [{ segment: ".text", start, end, bytes: 16 }],
          bytes: 16,
          skipped_uninitialized: [],
          skipped_not_loaded: [],
          skipped_overlay: [],
        },
        complete: true,
        next_cursor: null,
      }).success,
    ).toBe(true);
  },
);

describe("masked byte patterns", () => {
  it("preserves whole-byte wildcards and combines explicit bit masks", () => {
    for (const input of [
      { pattern: "48 8b\t??89", mask: "ff f0 ff 0f" },
      { pattern: "Aa\u00a000" },
      { pattern: "00" },
      { pattern: "????aa", mask: "000001" },
    ])
      expect(patternSchema.parse(input)).toEqual(input);
  });

  it.each([
    ["", undefined, "pattern"],
    ["4", undefined, "pattern"],
    ["4?", undefined, "pattern"],
    ["gg", undefined, "pattern"],
    ["?? ??", undefined, "pattern"],
    ["ff", "00", "pattern"],
    ["ffff", "ff", "mask"],
    ["ff", "??", "mask"],
    ["aa ??", "00 ff", "pattern"],
    ["??", "0000", "mask"],
    ["aa", "00gg", "mask"],
    ["??gg", "00gg", "pattern"],
  ])("rejects invalid pattern %s with typed issues", (pattern, mask, field) => {
    const parsed = patternSchema.safeParse({ pattern, mask });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected a rejected pattern");
    expect(parsed.error.issues).toMatchObject([
      { path: [field], code: "custom" },
    ]);
  });

  it("accepts ECMAScript whitespace only between complete byte pairs", () => {
    const whitespace = [
      "\t",
      "\n",
      "\v",
      "\f",
      "\r",
      " ",
      "\u00a0",
      "\u1680",
      ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];
    for (const separator of whitespace) {
      expect(
        patternSchema.safeParse({
          pattern: `aa${separator}??`,
          mask: `ff${separator}ff`,
        }).success,
      ).toBe(true);
      for (const pattern of [
        `${separator}aa`,
        `aa${separator}`,
        `a${separator}a`,
      ])
        expect(patternSchema.safeParse({ pattern }).success).toBe(false);
    }
    for (const separator of ["\u0085", "\u180e", "\u200b", "\u200c", "\u200d"])
      expect(
        patternSchema.safeParse({ pattern: `aa${separator}bb` }).success,
      ).toBe(false);
  });
});
