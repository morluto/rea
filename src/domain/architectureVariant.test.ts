import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_VARIANT_NAMES,
  ARCHITECTURE_VARIANTS,
  RAW_ENTRY_ISA_MODES,
  architectureVariantRow,
  architectureVariantSchema,
} from "./architectureVariant.js";
import { nativeSegmentsLoadImageSchema } from "./native/nativeLoadImage.js";
import {
  binaryArchitectureSchema,
  rawBinarySelectionError,
} from "./rawBinary.js";

describe.each(ARCHITECTURE_VARIANT_NAMES)("architecture variant %s", (name) => {
  const row = ARCHITECTURE_VARIANTS[name];

  it("names a raw-binary family and a known entry instruction set", () => {
    expect(binaryArchitectureSchema.options).toContain(row.architecture);
    expect(RAW_ENTRY_ISA_MODES).toContain(row.isaMode);
    expect(architectureVariantRow(name)).toEqual({ name, ...row });
  });

  it.each(binaryArchitectureSchema.options)(
    "pairs only with its own family, not %s otherwise",
    (architecture) => {
      expect(
        rawBinarySelectionError({
          format: "raw-binary",
          architecture,
          entryPoint: "0x8000000",
          baseAddress: "0x8000000",
          architectureVariant: name,
        }),
      ).toEqual(
        architecture === row.architecture
          ? undefined
          : {
              field: "architecture_variant",
              message: `architecture_variant ${name} requires architecture ${row.architecture}`,
            },
      );
    },
  );

  it("requires a base, which lets the entry be omitted", () => {
    const selection = {
      format: "raw-binary",
      architecture: row.architecture,
      architectureVariant: name,
    } as const;
    expect(
      rawBinarySelectionError({ ...selection, baseAddress: "0x8000000" }),
    ).toBeUndefined();
    // A variant never maps the image at its entry.
    for (const unbased of [
      selection,
      { ...selection, entryPoint: "0x8000000" },
    ])
      expect(rawBinarySelectionError(unbased)).toEqual({
        field: "base_address",
        message:
          "architecture_variant requires base_address, the address of file offset 0",
      });
  });
});

describe("architecture variant vocabulary", () => {
  // armv8.1m.main is the LLVM triple's spelling of armv8.1-m.main.
  it.each(["cortex-m", "ARMv7-M", "armv7m", "armv8-m", "armv8.1m.main", ""])(
    "accepts no spelling outside the table: %j",
    (spelling) => {
      expect(architectureVariantSchema.safeParse(spelling).success).toBe(false);
      expect(architectureVariantRow(spelling)).toBeUndefined();
    },
  );
});

describe("persisted architecture variant names", () => {
  // Saved segments Evidence and snapshots carry these names. Retiring one from
  // the input table must not make that Evidence unreadable.
  it.each([
    "armv6-m",
    "armv7-m",
    "armv7e-m",
    "armv8-m.base",
    "armv8-m.main",
    "armv8.1-m.main",
  ])("keeps %s readable in segments Evidence", (name) => {
    expect(
      nativeSegmentsLoadImageSchema.shape.architecture_variant.safeParse(name)
        .success,
    ).toBe(true);
  });
});
