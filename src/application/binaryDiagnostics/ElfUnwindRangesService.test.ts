import { parseEvidence } from "../../domain/evidence.js";
import { expect, it } from "vitest";
import { ElfUnwindRangesService } from "./ElfUnwindRangesService.js";
import { ELF_UNWIND_RANGES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  elfUnwindRangesSchema,
  inspectElfUnwindRangesInputSchema,
  type ElfUnwindRanges,
} from "../../domain/native/elfUnwindRanges.js";
import { parseElfUnwindRanges } from "../../native/elf/ElfUnwindTables.js";
import {
  elfUnwindAbsentFixture,
  elfUnwindFixture,
  elfUnwindSectionlessFixture,
} from "../../native/elf/ElfUnwindTables.fixture.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const identity = ELF_UNWIND_RANGES_PROVIDER;

const undecodableHeaderPointer = (): Buffer => {
  const bytes = elfUnwindSectionlessFixture();
  bytes[Number(bytes.readBigUInt64LE(64 + 56 + 8)) + 1] = 0x0f;
  return bytes;
};
const report: ElfUnwindRanges = {
  artifact: {
    path: "/artifacts/app",
    sha256: "a".repeat(64),
    bytes: 512,
  },
  format: "elf64",
  byte_order: "little",
  machine: 62,
  type: 3,
  type_name: "shared",
  eh_frame: { status: "absent", source: null, location: null },
  eh_frame_hdr: {
    status: "absent",
    location: null,
    version: null,
    eh_frame_pointer_encoding: null,
    fde_count_encoding: null,
    table_encoding: null,
    eh_frame_pointer: null,
    fde_count: null,
    table_entries: 0,
  },
  debug_frame: { status: "absent", location: null },
  cies: [],
  ranges: [],
  page: {
    offset: 0,
    limit: 256,
    returned: 0,
    total: 0,
    next_offset: null,
  },
  coverage: {
    status: "complete",
    total_ranges: 0,
    total_cies: 0,
    ranges_with_symbols: 0,
    ranges_without_symbols: 0,
    eh_frame_hdr_agreement: "unavailable",
    examined_records: 0,
  },
  limitations: [
    "No .eh_frame section or PT_GNU_EH_FRAME segment was declared.",
    "No .eh_frame_hdr section or PT_GNU_EH_FRAME segment was declared.",
    "CFA instructions are counted but not evaluated.",
    ".debug_frame is absent; only .eh_frame was examined.",
    "Symbol names, section names, and augmentation strings are target-derived and untrusted.",
  ],
};

const parsed = (
  bytes: Buffer,
  raw: Readonly<Record<string, unknown>> = {},
): ElfUnwindRanges => {
  const input = inspectElfUnwindRangesInputSchema.parse({
    path: "/artifacts/unwind.elf",
    ...raw,
  });
  return parseElfUnwindRanges(
    bytes,
    {
      path: input.path,
      sha256: "a".repeat(64),
      bytes: bytes.length,
    },
    input,
  );
};

const accept = async (
  value: ElfUnwindRanges,
  raw: Readonly<Record<string, unknown>> = {},
) => {
  const input = inspectElfUnwindRangesInputSchema.parse({
    path: value.artifact.path,
    ...raw,
  });
  return new ElfUnwindRangesService({
    identity,
    inspect: () => Promise.resolve(ok(value)),
  }).inspect(input);
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new ElfUnwindRangesService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "app" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records an absent unwind table for the selected ELF", async () => {
  const result = await accept(report);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: report,
  });
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: report.artifact.path },
  ]);
});

it.each([
  ["elf64 mismatch", elfUnwindFixture()],
  ["elf64 agreement", elfUnwindFixture({ header: "match" })],
  [
    "elf32 big-endian",
    elfUnwindFixture({ bits: 32, little: false, machine: 20, header: "match" }),
  ],
  ["sectionless", elfUnwindSectionlessFixture()],
  ["undecodable header pointer", undecodableHeaderPointer()],
  ["absent", elfUnwindAbsentFixture()],
  ["truncated", elfUnwindFixture({ truncate: true })],
  ["trailing", elfUnwindFixture({ trailingByte: true, header: "match" })],
  ["no header", elfUnwindFixture({ header: "absent" })],
  ["version 3", elfUnwindFixture({ version3: true, header: "match" })],
  ["dynsym", elfUnwindFixture({ symbolSource: "dynsym", header: "match" })],
  ["no symbols", elfUnwindFixture({ symbolSource: "none", header: "match" })],
  [
    "NOBITS .debug_frame",
    elfUnwindFixture({
      header: "match",
      backing: { section: ".debug_frame", kind: "nobits" },
    }),
  ],
  [
    ".debug_frame past end of file",
    elfUnwindFixture({
      backing: { section: ".debug_frame", kind: "past-eof" },
    }),
  ],
  [
    ".eh_frame past end of file",
    elfUnwindFixture({
      header: "match",
      backing: { section: ".eh_frame", kind: "past-eof" },
    }),
  ],
  [
    "NOBITS .eh_frame",
    elfUnwindFixture({ backing: { section: ".eh_frame", kind: "nobits" } }),
  ],
  [
    "NOBITS .eh_frame_hdr",
    elfUnwindFixture({ backing: { section: ".eh_frame_hdr", kind: "nobits" } }),
  ],
  [
    ".eh_frame_hdr past end of file",
    elfUnwindFixture({
      backing: { section: ".eh_frame_hdr", kind: "past-eof" },
    }),
  ],
  [
    "64-bit .eh_frame lengths",
    elfUnwindFixture({ header: "match", extendedLength: true }),
  ],
  [
    "DT_PLTGOT datarel",
    elfUnwindFixture({ header: "match", datarel: "dynamic" }),
  ],
  [
    "overstated .eh_frame_hdr fde_count",
    elfUnwindFixture({ header: "match", headerCount: 0x7fffffff }),
  ],
] as const)("accepts parser output for %s", async (_label, bytes) => {
  const value = parsed(bytes);
  const result = await accept(value);
  expect(result.ok, _label).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(value);
});

it("accepts a paged parser report without changing coverage", async () => {
  const value = parsed(elfUnwindFixture(), { offset: 1, limit: 1 });
  const result = await accept(value, { offset: 1, limit: 1 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    page: { offset: 1, limit: 1, returned: 1, total: 2, next_offset: null },
    coverage: { total_ranges: 2, ranges_with_symbols: 1 },
  });
});

it("bounds CIE Evidence locations by the page, not by the CIE count", async () => {
  const value = parsed(elfUnwindFixture({ extraCies: 500 }), {
    offset: 1,
    limit: 1,
  });
  expect(value.coverage.total_cies).toBe(502);
  const result = await accept(value, { offset: 1, limit: 1 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    cies: [{ index: 1 }],
  });
  // Artifact path, .eh_frame, .eh_frame_hdr, .debug_frame, one CIE, one FDE.
  expect(result.value.locations).toHaveLength(6);
});

it("rejects a page that returns a CIE none of its ranges name", async () => {
  const full = parsed(elfUnwindFixture({ extraCies: 2 }));
  const page = parsed(elfUnwindFixture({ extraCies: 2 }), {
    offset: 1,
    limit: 1,
  });
  const extra = full.cies[0];
  if (extra === undefined) throw new Error("fixture has no CIE");
  const result = await accept(
    { ...page, cies: [extra, ...page.cies] },
    { offset: 1, limit: 1 },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("accepts an FDE with a zero LSDA under a CIE that declares an LSDA encoding", async () => {
  const value = parsed(elfUnwindFixture({ zeroLsda: true }));
  expect(value.cies[1]?.lsda_encoding?.raw).toBe(0x1b);
  expect(value.ranges[1]?.lsda).toBeNull();
  const result = await accept(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    ranges: [{ lsda: null }, { lsda: null }],
  });
});

it("accepts a header that declares a count but omits its search table", async () => {
  const bytes = elfUnwindFixture({ header: "match" });
  const shoff = Number(bytes.readBigUInt64LE(40));
  const sections = bytes.readUInt16LE(60);
  const names = Number(
    bytes.readBigUInt64LE(shoff + bytes.readUInt16LE(62) * 64 + 24),
  );
  for (let index = 1; index < sections; index += 1) {
    const at = shoff + index * 64;
    const nameAt = names + bytes.readUInt32LE(at);
    if (
      bytes.toString("latin1", nameAt, bytes.indexOf(0, nameAt)) ===
      ".eh_frame_hdr"
    )
      bytes[Number(bytes.readBigUInt64LE(at + 24)) + 3] = 0xff;
  }
  const value = parsed(bytes);
  expect(value.eh_frame_hdr).toMatchObject({
    status: "present",
    fde_count: 2,
    table_encoding: { raw: 0xff },
  });
  const result = await accept(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    coverage: { status: "complete", eh_frame_hdr_agreement: "unavailable" },
  });
});

it("accepts a null personality stored under an indirect encoding", async () => {
  const value = parsed(elfUnwindFixture({ nullPersonality: true }));
  expect(value.cies[1]?.personality).toMatchObject({
    address: "0x0",
    indirect: false,
    encoding: { raw: 0x9b },
  });
  const result = await accept(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    ranges: [{ personality: null }, { personality: { address: "0x0" } }],
  });
});

it("rejects a direct personality reported as indirect", async () => {
  const value = parsed(elfUnwindFixture({ nullPersonality: true }));
  const cie = value.cies[1];
  if (cie?.personality == null) throw new Error("fixture has no personality");
  cie.personality.encoding = { raw: 0x1b, name: "pcrel|sdata4" };
  cie.personality.indirect = true;
  const result = await accept(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it.each([
  [
    "symbol totals",
    (value: ElfUnwindRanges) => {
      value.coverage.ranges_with_symbols += 1;
    },
  ],
  [
    "range outside the file",
    (value: ElfUnwindRanges) => {
      value.ranges[0]!.location.offset = value.artifact.bytes;
    },
  ],
  [
    "short page",
    (value: ElfUnwindRanges) => {
      value.ranges.pop();
      value.page.returned = 1;
      value.page.next_offset = 1;
    },
  ],
  [
    "agreement without the mismatch limitation",
    (value: ElfUnwindRanges) => {
      value.limitations = value.limitations.filter(
        (text) => !text.includes("does not match"),
      );
    },
  ],
] as const)("rejects parser output with %s", async (_label, mutate) => {
  const value = structuredClone(parsed(elfUnwindFixture()));
  mutate(value);
  const result = await accept(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("reports a header capped by max_ranges as an incomplete Result", async () => {
  const value = parsed(elfUnwindFixture({ header: "duplicate-row" }), {
    max_ranges: 2,
  });
  const result = await accept(value, { max_ranges: 2 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    eh_frame_hdr: { status: "incomplete", fde_count: 3, table_entries: 2 },
    coverage: { status: "incomplete", eh_frame_hdr_agreement: "unavailable" },
  });
});

it("rejects header table entries beyond the max_ranges budget", async () => {
  const value = structuredClone(
    parsed(elfUnwindFixture({ header: "duplicate-row" }), { max_ranges: 2 }),
  );
  value.eh_frame_hdr.table_entries = 3;
  const result = await accept(value, { max_ranges: 2 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a report whose artifact path is not the selected file", async () => {
  const value = structuredClone(parsed(elfUnwindFixture()));
  value.artifact.path = "/artifacts/other";
  const result = await new ElfUnwindRangesService({
    identity,
    inspect: () => Promise.resolve(ok(value)),
  }).inspect({ path: "/artifacts/unwind.elf" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a report that fails the output schema", async () => {
  const value = structuredClone(report);
  value.format = "elf128" as ElfUnwindRanges["format"];
  expect(elfUnwindRangesSchema.safeParse(value).success).toBe(false);
  const result = await accept(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains a completed observation when the caller cancels as the provider completes", async () => {
  const controller = new AbortController();
  const reason = { request: "late ElfUnwindRanges cancellation" };
  const service = new ElfUnwindRangesService({
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "inspect_elf_unwind_ranges",
    normalized_result: report,
  });
});
