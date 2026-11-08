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
  badCrcKernelConfigFixture,
  bzImageGzipFixture,
  bzImageXzFixture,
  kernelBuildConfigFixture,
  nonConfigGzipFixture,
  plainIkcfgStringFixture,
  truncatedKernelConfigFixture,
} from "../../native/elf/KernelBuildConfig.fixture.js";
import { parseKernelBuildConfig } from "../../native/elf/KernelBuildConfig.js";

const identity = KERNEL_BUILD_CONFIG_PROVIDER;
const path = "/artifacts/vmlinux";

const reportOf = (bytes: Buffer, extra: object = {}): KernelBuildConfig =>
  parseKernelBuildConfig(
    bytes,
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
      return Promise.resolve(ok(reportOf(kernelBuildConfigFixture())));
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

it.each([
  ["vmlinux", () => reportOf(kernelBuildConfigFixture()), "elf"],
  ["plain IKCFG_ST", () => reportOf(plainIkcfgStringFixture()), "elf"],
  ["malformed IKCFG text", () => reportOf(nonConfigGzipFixture()), "elf"],
  ["bad IKCFG CRC", () => reportOf(badCrcKernelConfigFixture()), "elf"],
  ["bzImage", () => reportOf(bzImageGzipFixture()), "file"],
  ["xz bzImage", () => reportOf(bzImageXzFixture()), "file"],
] as const)(
  "records parser output for %s as observed Evidence",
  async (_label, make, format) => {
    const report = make();
    const result = await serviceFor(report).inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      confidence: "observed",
      subject: { format },
      normalized_result: report,
    });
  },
);

it("records file ranges only for file-space locations", async () => {
  const report = reportOf(bzImageGzipFixture());
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

it.each([
  [
    "a config option count that disagrees with examined entries",
    (report: KernelBuildConfig): KernelBuildConfig => ({
      ...report,
      coverage: { ...report.coverage, examined_entries: 1 },
    }),
  ],
  [
    "a gzip range that does not follow its marker",
    (report: KernelBuildConfig): KernelBuildConfig => ({
      ...report,
      config: {
        ...report.config,
        gzip:
          report.config.gzip === null
            ? null
            : { ...report.config.gzip, offset: report.config.gzip.offset + 1 },
      },
    }),
  ],
  [
    "an unsupported payload without a next probe",
    (report: KernelBuildConfig): KernelBuildConfig => ({
      ...report,
      payload: { ...report.payload, status: "unsupported", codec: "xz" },
    }),
  ],
  [
    "a banner whose text does not carry its version",
    (report: KernelBuildConfig): KernelBuildConfig => ({
      ...report,
      banner: { ...report.banner, version: "9.9" },
    }),
  ],
  [
    "a malformed config reported with complete coverage",
    (): KernelBuildConfig => {
      const malformed = reportOf(nonConfigGzipFixture());
      return {
        ...malformed,
        coverage: { ...malformed.coverage, status: "complete" },
      };
    },
  ],
  [
    "an incomplete config carrying a malformed reason",
    (): KernelBuildConfig => {
      const truncated = reportOf(truncatedKernelConfigFixture());
      return {
        ...truncated,
        config: { ...truncated.config, reason: "config_text_invalid" },
      };
    },
  ],
] as const)("rejects %s", async (_label, mutate) => {
  const result = await serviceFor(
    mutate(reportOf(kernelBuildConfigFixture())),
  ).inspect({ path });
  if (result.ok) throw new Error("Expected malformed provider output");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a report whose page disagrees with the caller page", async () => {
  const result = await serviceFor(reportOf(kernelBuildConfigFixture())).inspect(
    { path, limit: 1 },
  );
  if (result.ok) throw new Error("Expected malformed provider output");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("does not call the provider after early cancellation", async () => {
  const service = new KernelBuildConfigService({
    identity,
    inspect: () => {
      throw new Error(
        "An already cancelled request must not reach its provider",
      );
    },
  });
  const result = await service.inspect(
    { path },
    { signal: AbortSignal.abort() },
  );
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});
