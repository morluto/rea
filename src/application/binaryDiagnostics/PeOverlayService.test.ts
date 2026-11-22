import { expect, it } from "vitest";
import { PE_OVERLAY_PROVIDER } from "../../domain/investigationProviders.js";
import {
  PE_OVERLAY_LIMITATIONS,
  PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS,
  PE_OVERLAY_MAX_REPORTED_SECTIONS,
  PE_OVERLAY_STRADDLING_SECURITY_LIMITATION,
  peOverlaySectionBudgetLimitation,
  type PeOverlay,
} from "../../domain/native/peOverlay.js";
import { ok } from "../../domain/result.js";
import { PeOverlayService } from "./PeOverlayService.js";

const limitations = (): string[] => [...PE_OVERLAY_LIMITATIONS];

const section = (
  overrides: Partial<PeOverlay["sections"][number]> = {},
): PeOverlay["sections"][number] => ({
  index: 0,
  name: ".text",
  pointer_to_raw_data: 0x200,
  rounded_pointer_to_raw_data: 0x200,
  size_of_raw_data: 0x200,
  characteristics: 0x60000020,
  raw_pointer_rounded: false,
  extends_image: true,
  ...overrides,
});

const other = (
  offset: number,
  size: number,
  overrides: Partial<
    Extract<PeOverlay["ranges"][number], { role: "other" }>
  > = {},
): Extract<PeOverlay["ranges"][number], { role: "other" }> => ({
  role: "other",
  offset,
  size,
  sha256: "a".repeat(64),
  entropy: {
    window_bytes: 4096,
    sampled_bytes: Math.min(size, 4096),
    shannon_bits: 0,
  },
  prefix_hex: "00".repeat(Math.min(size, 16)),
  leading_format: "unrecognized",
  ...overrides,
});

const absent = (): PeOverlay => ({
  artifact: {
    path: "/artifacts/app.exe",
    sha256: "a".repeat(64),
    bytes: 0x400,
  },
  format: "pe32",
  machine: 0x14c,
  size_of_headers: 0x200,
  image_end: 0x400,
  file_size: 0x400,
  present: false,
  raw_pointer_rounding: { alignment: 512, direction: "down" },
  sections: [section()],
  section_coverage: { status: "complete", declared: 1, reported: 1 },
  security_directory: { status: "absent" },
  ranges: [],
  limitations: limitations(),
});

/** 100 declared sections; only the budget is listed, the last one ends the image. */
const budgeted = (): PeOverlay => ({
  ...absent(),
  sections: Array.from({ length: PE_OVERLAY_MAX_REPORTED_SECTIONS }, (_, i) =>
    section({ index: i }),
  ),
  section_coverage: {
    status: "partial",
    declared: 100,
    reported: PE_OVERLAY_MAX_REPORTED_SECTIONS,
  },
  limitations: [...limitations(), peOverlaySectionBudgetLimitation(100)],
});

const appended = (): PeOverlay => ({
  ...absent(),
  artifact: { ...absent().artifact, bytes: 0x600 },
  file_size: 0x600,
  present: true,
  ranges: [other(0x400, 0x200)],
});

const signed = (): PeOverlay => ({
  ...absent(),
  security_directory: { status: "table", offset: 0x200, size: 0x80 },
  artifact: { ...absent().artifact, bytes: 0x300 },
  image_end: 0x200,
  file_size: 0x300,
  present: true,
  sections: [
    section({
      name: "",
      pointer_to_raw_data: 0,
      rounded_pointer_to_raw_data: 0,
      size_of_raw_data: 0,
      characteristics: 0,
      extends_image: false,
    }),
  ],
  ranges: [
    { role: "certificate_table", offset: 0x200, size: 0x80 },
    other(0x280, 0x80),
  ],
});

/** Pointer 0x410 maps from 0x400, but its declared bytes run through 0x610. */
const noncanonical = (): PeOverlay => ({
  ...absent(),
  artifact: { ...absent().artifact, bytes: 0x610 },
  image_end: 0x610,
  file_size: 0x610,
  sections: [
    section({
      pointer_to_raw_data: 0x410,
      rounded_pointer_to_raw_data: 0x400,
      raw_pointer_rounded: true,
    }),
  ],
});

const service = (value: PeOverlay = absent()) =>
  new PeOverlayService({
    identity: PE_OVERLAY_PROVIDER,
    inspect: () => Promise.resolve(ok(value)),
  });

it("retains an absent overlay and artifact provenance", async () => {
  const report = absent();
  const result = await service(report).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "derived",
    subject: { identity: { format: "pe", architecture: "x86" } },
    normalized_result: report,
    locations: [{ kind: "artifact-path", path: report.artifact.path }],
  });
});

it("locates every overlay range", async () => {
  const report = signed();
  const result = await service(report).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: report.artifact.path },
    { kind: "file-offset-range", start: 0x200, end: 0x280 },
    { kind: "file-offset-range", start: 0x280, end: 0x300 },
  ]);
});

it("retains a malformed security directory limitation on ordinary ranges", async () => {
  const report: PeOverlay = {
    ...appended(),
    security_directory: {
      status: "malformed",
      offset: 0x404,
      size: 0x10,
      defect: "unaligned",
    },
    limitations: [
      ...limitations(),
      PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS.unaligned,
    ],
  };
  const result = await service(report).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.limitations).toContain(
    PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS.unaligned,
  );
});

it("retains a security directory across the image end as ordinary ranges", async () => {
  const report: PeOverlay = {
    ...appended(),
    security_directory: { status: "table", offset: 0x3f0, size: 0x20 },
    limitations: [...limitations(), PE_OVERLAY_STRADDLING_SECURITY_LIMITATION],
  };
  const result = await service(report).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.limitations).toContain(
    PE_OVERLAY_STRADDLING_SECURITY_LIMITATION,
  );
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: report.artifact.path },
    { kind: "file-offset-range", start: 0x400, end: 0x600 },
  ]);
});

it("retains partial section coverage whose unlisted sections end the image", async () => {
  const report = budgeted();
  const result = await service(report).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.limitations).toContain(
    peOverlaySectionBudgetLimitation(100),
  );
});

it("accepts an image end at a noncanonical section's declared extent", async () => {
  const report = noncanonical();
  const result = await service(report).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
});

it("rejects input and cancellation before reading", async () => {
  const boundary = new PeOverlayService({
    identity: PE_OVERLAY_PROVIDER,
    inspect: () => {
      throw new Error("Unexpected read");
    },
  });
  for (const input of [
    { path: "relative.exe" },
    { path: absent().artifact.path, extra: true },
    { path: absent().artifact.path, max_file_bytes: 536870913 },
  ]) {
    const result = await boundary.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  }
  const result = await boundary.inspect(
    { path: absent().artifact.path },
    { signal: AbortSignal.abort() },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
});

it.each([
  { ...signed(), security_directory: { status: "absent" as const } },
  { ...signed(), ranges: [other(0x200, 0x100)] },
  {
    ...appended(),
    security_directory: { status: "table" as const, offset: 0x3f0, size: 0x20 },
  },
  { ...appended(), present: false },
  { ...appended(), ranges: [] },
  { ...appended(), ranges: [other(0x400, 0x100), other(0x500, 0x100)] },
  {
    ...appended(),
    ranges: [
      other(0x400, 1),
      { role: "certificate_table" as const, offset: 0x401, size: 0x1ff },
    ],
  },
  {
    ...absent(),
    artifact: { ...absent().artifact, path: "/another.exe" },
  },
  {
    ...absent(),
    artifact: { ...absent().artifact, bytes: 67108865 },
    file_size: 67108865,
    image_end: 67108865,
  },
  { ...absent(), file_size: 0x401 },
  {
    ...absent(),
    sections: [section({ extends_image: false })],
  },
  {
    ...absent(),
    sections: [section({ rounded_pointer_to_raw_data: 0x100 })],
  },
  {
    ...noncanonical(),
    image_end: 0x600,
    present: true,
    ranges: [other(0x600, 0x10)],
  },
  {
    ...appended(),
    ranges: [other(0x500, 0x100)],
  },
  {
    ...appended(),
    ranges: [
      other(0x400, 0x200, {
        entropy: { window_bytes: 4096, sampled_bytes: 1, shannon_bits: 0 },
      }),
    ],
  },
  {
    ...appended(),
    ranges: [other(0x400, 0x200, { prefix_hex: "00" })],
  },
  { ...absent(), limitations: [...limitations(), "extra"] },
  { ...budgeted(), limitations: limitations() },
  {
    ...budgeted(),
    section_coverage: {
      status: "complete" as const,
      declared: 96,
      reported: 96,
    },
  },
  {
    ...absent(),
    section_coverage: { status: "partial" as const, declared: 2, reported: 1 },
    limitations: [...limitations(), peOverlaySectionBudgetLimitation(2)],
  },
  {
    ...signed(),
    limitations: [
      ...limitations(),
      PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS.unaligned,
    ],
  },
  {
    ...signed(),
    ranges: [
      { role: "certificate_table" as const, offset: 0x200, size: 0x80 },
      { role: "certificate_table" as const, offset: 0x280, size: 0x80 },
    ],
  },
  {
    ...signed(),
    limitations: [...limitations(), PE_OVERLAY_STRADDLING_SECURITY_LIMITATION],
  },
  {
    ...absent(),
    limitations: [...limitations(), PE_OVERLAY_STRADDLING_SECURITY_LIMITATION],
  },
  {
    ...appended(),
    limitations: [
      ...limitations(),
      PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS.unaligned,
      PE_OVERLAY_STRADDLING_SECURITY_LIMITATION,
    ],
  },
])("rejects inconsistent provider output", async (value) => {
  const result = await service(value).inspect({
    path: absent().artifact.path,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
});
