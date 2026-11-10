import { expect, it } from "vitest";
import {
  BINARY_HARDENING_LIMITATIONS,
  ELF_HARDENING_PROPERTIES,
  MACHO_HARDENING_PROPERTIES,
  MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES,
  MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
  PE_HARDENING_PROPERTIES,
  binaryHardeningSchema,
  hardeningPropertiesFor,
  inspectBinaryHardeningInputSchema,
  type BinaryHardening,
  type BinaryHardeningProperty,
} from "./binaryHardening.js";

const row = (property: BinaryHardeningProperty) => ({
  property,
  state:
    property === "hardened_runtime"
      ? ("unknown" as const)
      : ("disabled" as const),
  confidence: "observed" as const,
  basis: property,
  location: null,
  note: null,
  next_probe: property === "hardened_runtime" ? "inspect_signature" : null,
});

const report = (): BinaryHardening => ({
  artifact: { path: "/artifacts/app", sha256: "a".repeat(64), bytes: 64 },
  format: "elf",
  images: [
    {
      format: "elf",
      status: "parsed",
      reason: null,
      architecture: "x86_64",
      bits: 64,
      byte_order: "little",
      machine: 62,
      slice: null,
      rows: ELF_HARDENING_PROPERTIES.map((property) => row(property)),
    },
  ],
  limitations: [...BINARY_HARDENING_LIMITATIONS],
});

it("defaults the read budget and rejects paths outside the ceiling", () => {
  expect(
    inspectBinaryHardeningInputSchema.parse({ path: "/artifacts/app" }),
  ).toEqual({ path: "/artifacts/app", max_file_bytes: 67108864 });
  for (const input of [
    { path: "relative" },
    { path: "/artifacts/app", extra: true },
    { path: "/artifacts/app", max_file_bytes: 63 },
    {
      path: "/artifacts/app",
      max_file_bytes: MAX_INSPECT_BINARY_HARDENING_FILE_BYTES + 1,
    },
  ])
    expect(inspectBinaryHardeningInputSchema.safeParse(input).success).toBe(
      false,
    );
});

it("keeps one property order per format", () => {
  expect(hardeningPropertiesFor("elf")).toEqual(ELF_HARDENING_PROPERTIES);
  expect(hardeningPropertiesFor("pe")).toEqual(PE_HARDENING_PROPERTIES);
  expect(hardeningPropertiesFor("mach-o")).toEqual(MACHO_HARDENING_PROPERTIES);
  expect(BINARY_HARDENING_LIMITATIONS).toHaveLength(6);
  expect(BINARY_HARDENING_LIMITATIONS.join("\n")).toContain(
    "inspect_signature",
  );
});

it("accepts a closed hardening report and rejects an empty image list", () => {
  const value = report();
  expect(binaryHardeningSchema.parse(value)).toEqual(value);
  expect(
    binaryHardeningSchema.safeParse({ ...value, images: [] }).success,
  ).toBe(false);
  expect(
    binaryHardeningSchema.safeParse({
      ...value,
      images: [
        {
          ...value.images[0],
          rows: [...value.images[0]!.rows, row("pie")],
        },
      ],
    }).success,
  ).toBe(true);
});

it("accepts a failed Mach-O slice that declares size 0", () => {
  const value = report();
  const failed = {
    format: "mach-o" as const,
    status: "malformed" as const,
    reason: "FAT architecture 0 has an invalid slice range",
    architecture: "arm64",
    bits: null,
    byte_order: null,
    machine: 0x0100000c,
    slice: {
      index: 0,
      file_offset: 32,
      size: 0,
      cpu_type: 0x0100000c,
      cpu_subtype: 0,
      architecture: "arm64",
    },
    rows: [],
  };
  expect(
    binaryHardeningSchema.parse({
      ...value,
      format: "mach-o",
      images: [failed],
    }).images[0]?.slice?.size,
  ).toBe(0);
  const wide = binaryHardeningSchema.parse({
    ...value,
    format: "mach-o",
    images: [
      {
        ...failed,
        slice: {
          ...failed.slice,
          file_offset: 2 ** 32,
          size: 2 ** 32,
        },
      },
    ],
  });
  expect(wide.images[0]?.slice?.file_offset).toBe(2 ** 32);
  expect(wide.images[0]?.slice?.size).toBe(2 ** 32);
  const noted = {
    ...value.images[0]!,
    rows: value.images[0]!.rows.map((entry) =>
      entry.property === "rpath"
        ? {
            ...entry,
            note: "A".repeat(MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES + 1),
          }
        : entry,
    ),
  };
  expect(
    binaryHardeningSchema.safeParse({ ...value, images: [noted] }).success,
  ).toBe(false);
});
