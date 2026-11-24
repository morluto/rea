import { expect, it } from "vitest";
import { KernelBuildConfigService } from "./KernelBuildConfigService.js";
import { KERNEL_BUILD_CONFIG_PROVIDER } from "../../domain/investigationProviders.js";
import {
  inspectKernelBuildConfigInputSchema,
  type KernelBuildConfig,
} from "../../domain/native/kernelBuildConfig.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  bzImageGzipFixture,
  bzImageXzFixture,
  kernelBuildConfigFixture,
  nonConfigGzipFixture,
  truncatedKernelConfigFixture,
} from "../../native/elf/KernelBuildConfig.fixture.js";
import { parseKernelBuildConfigFromHandle } from "../../native/elf/KernelBuildConfig.js";
import type { ByteSource } from "../../domain/byteSource.js";
import { bufferByteSource } from "../../domain/byteSource.js";

const identity = KERNEL_BUILD_CONFIG_PROVIDER;
const path = "/artifacts/vmlinux";

const reportOf = (
  bytes: Buffer,
  extra: object = {},
): Promise<KernelBuildConfig> =>
  parseKernelBuildConfigFromHandle(
    bufferByteSource(bytes),
    { path, sha256: "a".repeat(64), bytes: bytes.length },
    inspectKernelBuildConfigInputSchema.parse({ path, ...extra }),
  );

const serviceFor = (report: KernelBuildConfig) =>
  new KernelBuildConfigService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  });

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new KernelBuildConfigService({
    identity,
    inspect: () => {
      calls += 1;
      return reportOf(kernelBuildConfigFixture()).then(ok);
    },
  });
  const relative = await service.inspect({ path: "vmlinux" });
  const extra = await service.inspect({ path, extra: true });
  const badName = await service.inspect({ path, name: "SELINUX" });
  for (const result of [relative, extra, badName]) {
    if (result.ok) throw new Error("Expected input rejection");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls).toBe(0);
});

it("records file ranges only for file-space locations", async () => {
  const report = await reportOf(bzImageGzipFixture());
  const result = await serviceFor(report).inspect({ path });
  if (!result.ok) throw result.error;
  const ranges = result.value.locations?.filter(
    (location) => location.kind === "file-offset-range",
  );
  expect(ranges).toEqual([
    {
      kind: "file-offset-range",
      start: report.payload.offset,
      end: (report.payload.offset ?? 0) + (report.payload.bytes ?? 0),
    },
  ]);
});

it("refuses file coordinates for metadata read from an inflated payload", async () => {
  const report = await reportOf(bzImageGzipFixture());
  const { banner, config } = report;
  const { marker, gzip, end_marker } = config;
  if (
    banner.location === null ||
    marker === null ||
    gzip === null ||
    end_marker === null
  )
    throw new Error("Expected an inflated banner and framed config");
  for (const misplaced of [
    {
      ...report,
      banner: { ...banner, location: { ...banner.location, space: "file" } },
    },
    {
      ...report,
      config: {
        ...config,
        marker: { ...marker, space: "file" },
        gzip: { ...gzip, space: "file" },
        end_marker: { ...end_marker, space: "file" },
      },
    },
  ] satisfies KernelBuildConfig[]) {
    const result = await serviceFor(misplaced).inspect({ path });
    if (result.ok)
      throw new Error(
        "Evidence falsely attributed an inflated range to the file",
      );
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
});

it("rejects provider reports with inconsistent bounds, framing, or coverage", async () => {
  const [valid, unsupported, malformed, truncated] = await Promise.all([
    reportOf(kernelBuildConfigFixture()),
    reportOf(bzImageXzFixture()),
    reportOf(nonConfigGzipFixture()),
    reportOf(truncatedKernelConfigFixture()),
  ]);
  expect(await serviceFor(malformed).inspect({ path })).toMatchObject({
    ok: true,
    value: {
      normalized_result: {
        config: { status: "malformed", reason: "config_text_invalid" },
        coverage: { status: "unknown" },
      },
    },
  });
  const { gzip, end_marker } = valid.config;
  if (gzip === null || end_marker === null || unsupported.next_probe === null)
    throw new Error("Expected framed and unsupported fixture reports");
  const invalidReports = {
    "wrong examined count": {
      ...valid,
      coverage: { ...valid.coverage, examined_entries: 1 },
    },
    "gzip does not start after the opening marker": {
      ...valid,
      config: {
        ...valid.config,
        gzip: { ...gzip, offset: gzip.offset + 1, bytes: gzip.bytes - 1 },
      },
    },
    "closing marker overlaps the gzip trailer": {
      ...valid,
      config: {
        ...valid.config,
        end_marker: { ...end_marker, offset: end_marker.offset - 1 },
      },
    },
    "unsupported codec without recovery": { ...unsupported, next_probe: null },
    "banner version differs from text": {
      ...valid,
      banner: { ...valid.banner, version: "9.9" },
    },
    "malformed text overclaimed as complete": {
      ...malformed,
      coverage: { ...malformed.coverage, status: "complete" },
    },
    "malformed text classified as a partial gap": {
      ...malformed,
      coverage: { ...malformed.coverage, status: "partial" },
    },
    "known truncation classified as unknown": {
      ...truncated,
      coverage: { ...truncated.coverage, status: "unknown" },
    },
    "known truncation classified as malformed": {
      ...truncated,
      config: { ...truncated.config, reason: "config_text_invalid" },
    },
    "empty limitations": {
      ...valid,
      limitations: [],
    },
    "non-untrusted banner trust": {
      ...valid,
      banner: {
        ...valid.banner,
        trust: "trusted" as KernelBuildConfig["banner"]["trust"],
      },
    },
  } satisfies Record<string, KernelBuildConfig>;
  for (const [defect, report] of Object.entries(invalidReports))
    expect(await serviceFor(report).inspect({ path }), defect).toMatchObject({
      ok: false,
      error: expect.any(AnalysisOutputError),
    });

  // Untrustedness is validated via structured trust fields rather than prose scanning.
  expect(
    await serviceFor({
      ...valid,
      limitations: ["This workflow does not execute the image."],
    }).inspect({ path }),
  ).toMatchObject({ ok: true });
});

it("rejects a report whose page disagrees with the caller page", async () => {
  const result = await serviceFor(
    await reportOf(kernelBuildConfigFixture()),
  ).inspect({ path, limit: 1 });
  if (result.ok) throw new Error("Expected malformed provider output");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("does not call the provider after early cancellation", async () => {
  let calls = 0;
  const service = new KernelBuildConfigService({
    identity,
    inspect: () => {
      calls += 1;
      return reportOf(kernelBuildConfigFixture()).then(ok);
    },
  });
  const result = await service.inspect(
    { path },
    { signal: AbortSignal.abort() },
  );
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(calls).toBe(0);
});
