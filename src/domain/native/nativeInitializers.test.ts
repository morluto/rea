import { expect, it } from "vitest";
import {
  inspectNativeInitializersInputSchema,
  nativeInitializersSchema,
  NATIVE_INITIALIZER_LIMITATIONS,
} from "./nativeInitializers.js";

it("applies paging defaults and rejects relative paths and extra arguments", () => {
  expect(
    inspectNativeInitializersInputSchema.parse({ path: "/artifacts/app" }),
  ).toMatchObject({
    offset: 0,
    limit: 64,
    max_file_bytes: 67108864,
  });
  for (const input of [
    { path: "app" },
    { path: "/artifacts/app", extra: true },
    { path: "/artifacts/app", limit: 0 },
    { path: "/artifacts/app", limit: 4097 },
  ])
    expect(inspectNativeInitializersInputSchema.safeParse(input).success).toBe(
      false,
    );
});

it("admits an empty inventory and rejects an unknown resolution", () => {
  const report = {
    artifact: { path: "/artifacts/app", sha256: "a".repeat(64), bytes: 512 },
    format: "elf" as const,
    status: "parsed" as const,
    applicability: "applicable" as const,
    architecture: "x86_64" as const,
    bits: 64 as const,
    byte_order: "little" as const,
    machine: 62,
    elf_type: 3,
    slice: null,
    coverage: {
      status: "complete" as const,
      examined_entries: 0,
      total_entries: 0,
      returned_entries: 0,
      offset: 0,
      limit: 64,
    },
    entries: [],
    limitations: [...NATIVE_INITIALIZER_LIMITATIONS],
  };
  expect(nativeInitializersSchema.parse(report)).toEqual(report);
  const entry = {
    index: 0,
    kind: "init_array",
    slot_va: "0x200",
    slot_file_offset: 512,
    slot_bytes: 8,
    value_va: null,
    value_file_offset: null,
    slot_section: null,
    section: null,
    symbol: null,
    resolution: "guessed",
    detail: null,
  };
  expect(
    nativeInitializersSchema.safeParse({ ...report, entries: [entry] }).success,
  ).toBe(false);
});
