import { lateCancellationEvidence } from "../../../tests/support/lateCancellationEvidence.js";
import { expect, it } from "vitest";
import { KernelModuleService } from "./KernelModuleService.js";
import { KERNEL_MODULE_PROVIDER } from "../../domain/investigationProviders.js";
import type { KernelModule } from "../../domain/native/kernelModule.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const identity = KERNEL_MODULE_PROVIDER;
const digest = "a".repeat(64);
const report: KernelModule = {
  artifact: { path: "/artifacts/demo.ko", sha256: digest, bytes: 512 },
  format: "elf64",
  byte_order: "little",
  machine: 62,
  type: 1,
  type_name: "relocatable",
  applicability: "applicable",
  compression: null,
  next_probe: null,
  modinfo: {
    status: "present",
    location: { offset: 64, bytes: 0 },
    sha256: digest,
    entries: [],
    reason: null,
  },
  versions: {
    status: "absent",
    layout: "elf64_unsigned_long_name56",
    entry_bytes: 64,
    location: null,
    sha256: null,
    entries: [],
    reason: null,
  },
  this_module: {
    status: "absent",
    location: null,
    layout: "unknown",
  },
  ksymtab: { status: "observed", sections: [] },
  init_text: {
    status: "absent",
    location: null,
    bytes: null,
    compressed: null,
  },
  exit_text: {
    status: "absent",
    location: null,
    bytes: null,
    compressed: null,
  },
  signature: {
    status: "absent",
    magic: null,
    info: null,
    pkcs7: null,
    reason: null,
  },
  coverage: { status: "complete", examined_entries: 0 },
  limitations: ["Kernel module metadata was not executed."],
};

it("rejects relative paths, extra arguments and invalid field budgets before reading", async () => {
  let calls = 0;
  const service = new KernelModuleService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "demo.ko" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  for (const budget of ["max_modinfo_key_bytes", "max_modinfo_value_bytes"]) {
    for (const value of [0, 536870913]) {
      const invalid = await service.inspect({
        path: report.artifact.path,
        [budget]: value,
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok)
        expect(invalid.error).toMatchObject({
          _tag: "AnalysisInputError",
          issues: [expect.objectContaining({ path: [budget] })],
        });
    }
  }
  expect(calls).toBe(0);
});

it("requires a nonempty PKCS#7 range ending at the file trailer", async () => {
  const valid = {
    status: "present",
    reason: null,
    magic: { offset: 484, bytes: 28 },
    info: {
      location: { offset: 472, bytes: 12 },
      algo: 0,
      hash: 0,
      id_type: 2,
      signer_len: 0,
      key_id_len: 0,
      pad: [0, 0, 0],
      sig_len: 5,
    },
    pkcs7: { location: { offset: 467, bytes: 5 }, sha256: digest },
  } satisfies KernelModule["signature"];
  const empty = {
    ...valid,
    info: { ...valid.info, sig_len: 0 },
    pkcs7: {
      location: { offset: valid.info.location.offset, bytes: 0 },
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  };
  const beforeEof = {
    ...valid,
    magic: { ...valid.magic, offset: 483 },
    info: { ...valid.info, location: { ...valid.info.location, offset: 471 } },
    pkcs7: {
      ...valid.pkcs7,
      location: { ...valid.pkcs7.location, offset: 466 },
    },
  };
  const outcomes = await Promise.all(
    [valid, empty, beforeEof].map((signature) =>
      new KernelModuleService({
        identity,
        inspect: () => Promise.resolve(ok({ ...report, signature })),
      }).inspect({ path: report.artifact.path }),
    ),
  );
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, false]);
  for (const outcome of outcomes.slice(1)) {
    if (outcome.ok)
      throw new Error("Expected inconsistent signature rejection");
    expect(outcome.error).toBeInstanceOf(AnalysisOutputError);
  }
});

it("rejects a report whose entry count does not match the examined sections", async () => {
  const result = await new KernelModuleService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          coverage: { status: "complete", examined_entries: 1 },
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it.each([
  ["__ksymtab", "ksymtab_name_exceeds_limit"],
  [null, null],
] as const)(
  "rejects a __ksymtab listing whose name %s disagrees with reason %s",
  async (name, reason) => {
    const result = await new KernelModuleService({
      identity,
      inspect: () =>
        Promise.resolve(
          ok({
            ...report,
            ksymtab: {
              status: "observed",
              sections: [
                {
                  name,
                  location: { offset: 64, bytes: 0 },
                  compressed: false,
                  reason,
                },
              ],
            },
            coverage: { status: "complete", examined_entries: 1 },
          }),
        ),
    }).inspect({ path: report.artifact.path });
    if (result.ok) throw new Error("Expected malformed provider output");
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
  },
);

it("retains a completed observation if the caller cancels while the provider completes", async () => {
  const evidence = await lateCancellationEvidence(
    report,
    "late kernel module cancellation",
    (inspect) => new KernelModuleService({ identity, inspect }),
  );
  expect(evidence).toMatchObject({
    operation: "inspect_kernel_module",
    confidence: "observed",
    subject: { identity: { format: "elf", architecture: "x86_64" } },
    normalized_result: report,
  });
});

it("validates ksymtab strings, kcrctab, and extended_versions invariants and retains Evidence locations", async () => {
  const validExtended: KernelModule = {
    ...report,
    extended_versions: {
      status: "present",
      entry_crc_bytes: 4,
      names_section: {
        status: "present",
        location: { offset: 128, bytes: 7 },
        sha256: digest,
        count: 1,
        reason: null,
      },
      crcs_section: {
        status: "present",
        location: { offset: 140, bytes: 4 },
        sha256: digest,
        count: 1,
        reason: null,
      },
      entries: [
        {
          index: 0,
          crc_hex: "12345678",
          crc_location: { offset: 140, bytes: 4 },
          name: "printk",
          name_location: { offset: 128, bytes: 7 },
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
      status: "observed",
      sections: [],
      strings: {
        status: "present",
        location: { offset: 160, bytes: 4 },
        sha256: digest,
        entries: [
          {
            index: 0,
            location: { offset: 160, bytes: 4 },
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
        location: { offset: 168, bytes: 4 },
        sha256: digest,
        entries: [
          {
            index: 0,
            location: { offset: 168, bytes: 4 },
            crc_hex: "abcdef01",
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
    coverage: { status: "complete", examined_entries: 3 },
  };
  const validResult = await new KernelModuleService({
    identity,
    inspect: () => Promise.resolve(ok(validExtended)),
  }).inspect({ path: report.artifact.path });
  expect(validResult.ok).toBe(true);
  if (validResult.ok)
    expect(validResult.value.locations).toEqual(
      expect.arrayContaining([
        { kind: "file-offset-range", start: 128, end: 135 },
        { kind: "file-offset-range", start: 140, end: 144 },
        { kind: "file-offset-range", start: 160, end: 164 },
        { kind: "file-offset-range", start: 168, end: 172 },
      ]),
    );

  const invalidCases: KernelModule[] = [
    { ...validExtended, coverage: { status: "complete", examined_entries: 2 } },
    {
      ...validExtended,
      ksymtab: {
        ...validExtended.ksymtab!,
        kcrctab: {
          ...validExtended.ksymtab!.kcrctab!,
          entries: [
            {
              index: 0,
              location: { offset: 169, bytes: 4 },
              crc_hex: "abcdef01",
            },
          ],
        },
      },
    },
    {
      ...validExtended,
      extended_versions: {
        ...validExtended.extended_versions!,
        names_section: {
          ...validExtended.extended_versions!.names_section,
          count: 2,
        },
      },
    },
  ];
  for (const invalid of invalidCases) {
    const outcome = await new KernelModuleService({
      identity,
      inspect: () => Promise.resolve(ok(invalid)),
    }).inspect({ path: report.artifact.path });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(AnalysisOutputError);
  }
});
