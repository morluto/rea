import { expect, it } from "vitest";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
} from "./kernelModule.js";

it("applies the default kernel-module read and entry budgets", () => {
  expect(
    inspectKernelModuleInputSchema.parse({ path: "/artifacts/demo.ko" }),
  ).toMatchObject({
    max_file_bytes: 67108864,
    max_entries: 8192,
  });
});

it("limits the external recovery probe to decompression", () => {
  expect(
    kernelModuleSchema.shape.next_probe.safeParse({
      operation: "extract_artifact",
      rationale: "Test declared operation",
    }).success,
  ).toBe(false);
});

it("accepts strictly additive ksymtab strings, kcrctab, and extended_versions fields", () => {
  const digest = "a".repeat(64);
  const minimal = {
    artifact: { path: "/artifacts/demo.ko", sha256: digest, bytes: 256 },
    format: "elf64" as const,
    byte_order: "little" as const,
    machine: 62,
    type: 1,
    type_name: "relocatable" as const,
    applicability: "applicable" as const,
    compression: null,
    next_probe: null,
    modinfo: {
      status: "absent" as const,
      location: null,
      sha256: null,
      entries: [],
      reason: null,
    },
    versions: {
      status: "absent" as const,
      layout: "elf64_unsigned_long_name56" as const,
      entry_bytes: 64 as const,
      location: null,
      sha256: null,
      entries: [],
      reason: null,
    },
    this_module: {
      status: "absent" as const,
      location: null,
      layout: "unknown" as const,
    },
    ksymtab: { status: "observed" as const, sections: [] },
    init_text: {
      status: "absent" as const,
      location: null,
      bytes: null,
      compressed: null,
    },
    exit_text: {
      status: "absent" as const,
      location: null,
      bytes: null,
      compressed: null,
    },
    signature: {
      status: "absent" as const,
      magic: null,
      info: null,
      pkcs7: null,
      reason: null,
    },
    coverage: { status: "complete" as const, examined_entries: 0 },
    limitations: [],
  };
  expect(kernelModuleSchema.safeParse(minimal).success).toBe(true);
  expect(
    kernelModuleSchema.safeParse({
      ...minimal,
      extended_versions: {
        status: "present",
        entry_crc_bytes: 4,
        names_section: {
          status: "present",
          location: { offset: 64, bytes: 7 },
          sha256: digest,
          count: 1,
          reason: null,
        },
        crcs_section: {
          status: "present",
          location: { offset: 72, bytes: 4 },
          sha256: digest,
          count: 1,
          reason: null,
        },
        entries: [
          {
            index: 0,
            crc_hex: "deadbeef",
            crc_location: { offset: 72, bytes: 4 },
            name: "printk",
            name_location: { offset: 64, bytes: 7 },
            name_sha256: digest,
            name_raw_hex: "7072696e746b00",
            status: "observed",
            reason: null,
            omitted: false,
          },
        ],
        reason: null,
      },
      ksymtab: {
        ...minimal.ksymtab,
        strings: {
          status: "present",
          location: { offset: 80, bytes: 4 },
          sha256: digest,
          entries: [
            {
              index: 0,
              location: { offset: 80, bytes: 4 },
              value: "sym",
              raw_sha256: digest,
              raw_hex: "73796d00",
              status: "observed",
              reason: null,
              omitted: false,
            },
          ],
          reason: null,
        },
        kcrctab: {
          status: "present",
          entry_bytes: 4,
          location: { offset: 84, bytes: 4 },
          sha256: digest,
          entries: [
            {
              index: 0,
              location: { offset: 84, bytes: 4 },
              crc_hex: "01020304",
            },
          ],
          reason: null,
        },
        kcrctab_gpl: {
          status: "absent",
          entry_bytes: 4,
          location: null,
          sha256: null,
          entries: [],
          reason: null,
        },
      },
    }).success,
  ).toBe(true);
});
