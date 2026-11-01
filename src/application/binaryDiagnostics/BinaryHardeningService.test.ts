import { expect, it } from "vitest";
import { BinaryHardeningService } from "./BinaryHardeningService.js";
import { BINARY_HARDENING_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BINARY_HARDENING_LIMITATIONS,
  ELF_HARDENING_PROPERTIES,
  MACHO_HARDENING_PROPERTIES,
  type BinaryHardening,
  type BinaryHardeningImage,
  type BinaryHardeningProperty,
  type BinaryHardeningRow,
} from "../../domain/native/binaryHardening.js";
import { ok } from "../../domain/result.js";

const DIGEST = "a".repeat(64);

const row = (
  property: BinaryHardeningProperty,
  patch: Partial<BinaryHardeningRow> = {},
): BinaryHardeningRow => ({
  property,
  state: property === "hardened_runtime" ? "unknown" : "disabled",
  confidence: "observed",
  basis: property,
  location: null,
  note: null,
  next_probe: property === "hardened_runtime" ? "inspect_signature" : null,
  ...patch,
});

const image = (
  format: BinaryHardeningImage["format"],
  properties: readonly BinaryHardeningProperty[],
  patch: Partial<BinaryHardeningImage> = {},
): BinaryHardeningImage => ({
  format,
  status: "parsed",
  reason: null,
  architecture: "x86_64",
  bits: 64,
  byte_order: "little",
  machine: 62,
  slice: null,
  rows: properties.map((property) =>
    property === "pie" && format === "elf"
      ? row(property, { state: "enabled", confidence: "derived" })
      : row(property),
  ),
  ...patch,
});

const report = (
  patch: Partial<BinaryHardening> = {},
  imagePatch: Partial<BinaryHardeningImage> = {},
): BinaryHardening => ({
  artifact: { path: "/artifacts/app", sha256: DIGEST, bytes: 128 },
  format: "elf",
  images: [image("elf", ELF_HARDENING_PROPERTIES, imagePatch)],
  limitations: [...BINARY_HARDENING_LIMITATIONS],
  ...patch,
});

const service = (value: BinaryHardening = report()) =>
  new BinaryHardeningService({
    identity: BINARY_HARDENING_PROVIDER,
    inspect: () => Promise.resolve(ok(value)),
  });

it("returns derived Evidence for a multi-field ELF row", async () => {
  const value = report();
  const result = await service(value).inspect({ path: value.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "derived",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: value,
  });
  expect(result.value.limitations).toEqual([...BINARY_HARDENING_LIMITATIONS]);
});

it("labels one Mach-O slice as a universal image and omits derived confidence", async () => {
  const slice = {
    index: 0,
    file_offset: 8,
    size: 32,
    cpu_type: 0x0100000c,
    cpu_subtype: 0,
    architecture: "arm64",
  };
  const value = report(
    { format: "mach-o" },
    {
      format: "mach-o",
      architecture: "arm64",
      machine: 0x0100000c,
      slice,
      rows: MACHO_HARDENING_PROPERTIES.map((property) => row(property)),
    },
  );
  const result = await service(value).inspect({ path: value.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.confidence).toBe("observed");
  expect(result.value.subject).toMatchObject({
    format: "mach-o-universal",
    architecture: "arm64",
  });
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: value.artifact.path },
    { kind: "file-offset-range", start: 8, end: 40 },
  ]);
});

it("omits architecture when more than one slice is present", async () => {
  const sliceAt = (index: number) => ({
    index,
    file_offset: index * 32,
    size: 32,
    cpu_type: 0x0100000c,
    cpu_subtype: index,
    architecture: index === 0 ? "arm64" : "arm64e",
  });
  const value: BinaryHardening = {
    artifact: { path: "/artifacts/app", sha256: DIGEST, bytes: 128 },
    format: "mach-o",
    limitations: [...BINARY_HARDENING_LIMITATIONS],
    images: [0, 1].map((index) =>
      image("mach-o", MACHO_HARDENING_PROPERTIES, {
        architecture: "arm64",
        slice: sliceAt(index),
        rows: MACHO_HARDENING_PROPERTIES.map((property) =>
          row(property, {
            location: { offset: 24 + index, bytes: 1 },
          }),
        ),
      }),
    ),
  };
  const result = await service(value).inspect({ path: value.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.subject).toMatchObject({
    format: "mach-o-universal",
    architecture: null,
  });
});

it("rejects input and cancellation before reading", async () => {
  const boundary = new BinaryHardeningService({
    identity: BINARY_HARDENING_PROVIDER,
    inspect: () => {
      throw new Error("Unexpected read");
    },
  });
  for (const input of [
    { path: "relative" },
    { path: "/artifacts/app", extra: true },
    { path: "/artifacts/app", max_file_bytes: 536870913 },
  ]) {
    const result = await boundary.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  }
  const result = await boundary.inspect(
    { path: "/artifacts/app" },
    { signal: AbortSignal.abort() },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
});

it.each([
  report({ artifact: { path: "/other", sha256: DIGEST, bytes: 128 } }),
  report({
    limitations: BINARY_HARDENING_LIMITATIONS.slice(0, 4),
  }),
  report(
    { artifact: { path: "/artifacts/app", sha256: DIGEST, bytes: 80 } },
    {},
  ),
  report(
    {},
    {
      rows: [...ELF_HARDENING_PROPERTIES]
        .reverse()
        .map((property) => row(property)),
    },
  ),
  report(
    {},
    {
      rows: ELF_HARDENING_PROPERTIES.map((property) =>
        row(
          property,
          property === "pie" ? { next_probe: "inspect_signature" } : {},
        ),
      ),
    },
  ),
  report(
    { format: "mach-o" },
    {
      format: "mach-o",
      rows: MACHO_HARDENING_PROPERTIES.map((property) =>
        row(
          property,
          property === "hardened_runtime" ? { state: "enabled" } : {},
        ),
      ),
    },
  ),
  report(
    { format: "mach-o" },
    {
      format: "mach-o",
      rows: MACHO_HARDENING_PROPERTIES.map((property) =>
        row(property, {
          next_probe: property === "hardened_runtime" ? "inspect_macho" : null,
        }),
      ),
    },
  ),
  report(
    {},
    {
      rows: ELF_HARDENING_PROPERTIES.map((property) =>
        row(property, { location: { offset: 120, bytes: 16 } }),
      ),
    },
  ),
  report({
    format: "mach-o",
    images: [
      image("mach-o", MACHO_HARDENING_PROPERTIES),
      image("mach-o", MACHO_HARDENING_PROPERTIES),
    ],
  }),
  report({}, { status: "malformed", reason: "truncated", rows: [] }),
  report(
    {},
    {
      slice: {
        index: 0,
        file_offset: 0,
        size: 16,
        cpu_type: 1,
        cpu_subtype: 0,
        architecture: "arm64",
      },
    },
  ),
])("rejects inconsistent provider output", async (value) => {
  const input =
    value.artifact.bytes === 80
      ? { path: "/artifacts/app", max_file_bytes: 64 }
      : { path: "/artifacts/app" };
  const result = await service(value).inspect(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
});

it("keeps sibling Mach-O slices when one range is empty or past EOF", async () => {
  const slice = (
    index: number,
    file_offset: number,
    size: number,
  ): NonNullable<BinaryHardeningImage["slice"]> => ({
    index,
    file_offset,
    size,
    cpu_type: 0x0100000c,
    cpu_subtype: 0,
    architecture: "arm64",
  });
  const failed = (
    index: number,
    file_offset: number,
    size: number,
    reason: string,
  ): BinaryHardeningImage =>
    image("mach-o", MACHO_HARDENING_PROPERTIES, {
      status: "malformed",
      reason,
      rows: [],
      architecture: "arm64",
      bits: null,
      byte_order: null,
      machine: 0x0100000c,
      slice: slice(index, file_offset, size),
    });
  const value = report({
    format: "mach-o",
    images: [
      image("mach-o", MACHO_HARDENING_PROPERTIES, {
        architecture: "arm64",
        machine: 0x0100000c,
        slice: slice(0, 0, 64),
      }),
      failed(
        1,
        96,
        64,
        "FAT architecture 1 slice range extends beyond the file",
      ),
      failed(2, 80, 0, "FAT architecture 2 has an invalid slice range"),
    ],
  });
  const result = await service(value).inspect({ path: value.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    images: [
      { status: "parsed" },
      { status: "malformed" },
      { status: "malformed" },
    ],
  });
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: value.artifact.path },
    { kind: "file-offset-range", start: 0, end: 64 },
  ]);
});

it("keeps a sibling when a failed slice declares an offset past 2^32", async () => {
  const slice = (
    index: number,
    file_offset: number,
    size: number,
  ): NonNullable<BinaryHardeningImage["slice"]> => ({
    index,
    file_offset,
    size,
    cpu_type: 0x0100000c,
    cpu_subtype: 0,
    architecture: "arm64",
  });
  const value = report({
    format: "mach-o",
    images: [
      image("mach-o", MACHO_HARDENING_PROPERTIES, {
        architecture: "arm64",
        machine: 0x0100000c,
        slice: slice(0, 0, 64),
      }),
      image("mach-o", MACHO_HARDENING_PROPERTIES, {
        status: "malformed",
        reason: "FAT64 slice offset exceeds 32 bits",
        rows: [],
        architecture: "arm64",
        bits: null,
        byte_order: null,
        machine: 0x0100000c,
        slice: slice(1, 2 ** 32, 2 ** 32),
      }),
    ],
  });
  const result = await service(value).inspect({ path: value.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: value.artifact.path },
    { kind: "file-offset-range", start: 0, end: 64 },
  ]);
});

it("rejects a thin Mach-O malformed image that has no slice", async () => {
  const value = report(
    { format: "mach-o" },
    {
      format: "mach-o",
      status: "malformed",
      reason: "Mach-O header is truncated",
      rows: [],
      architecture: null,
      bits: null,
      byte_order: null,
      machine: null,
      slice: null,
    },
  );
  const result = await service(value).inspect({ path: value.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
});
