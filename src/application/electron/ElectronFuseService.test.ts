import { expect, it } from "vitest";
import type { ElectronFuseReport } from "../../domain/electron/electronFuses.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { ElectronFuseService } from "./ElectronFuseService.js";

const identity = { id: "fuse-fixture", name: "Fixture", version: "1" };
const report: ElectronFuseReport = {
  artifact: {
    selected_path: "/artifacts/app",
    resolved_path: "/artifacts/app",
    sha256: "a".repeat(64),
    bytes: 0,
    format: "elf",
  },
  slices: [
    {
      index: 0,
      file_offset: 0,
      size: 0,
      architecture: null,
      sentinel_count: 0,
      sentinels: [],
    },
  ],
  runtime_implications: [],
  limitations: ["source-owned fixture"],
};

it("retains completed fuse Evidence when the provider completes after abort", async () => {
  const controller = new AbortController();
  const reason = { requested: "stop after fuse inspection" };
  const result = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => {
      controller.abort(reason);
      return ok(report);
    },
  }).inspect(
    { path: report.artifact.selected_path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "inspect_electron_fuses",
      provider: identity,
      subject: {
        local_path: report.artifact.resolved_path,
        identity: {
          sha256: report.artifact.sha256,
          format: report.artifact.format,
        },
      },
      parameters: { path: report.artifact.selected_path },
      confidence: "observed",
      limitations: expect.arrayContaining(report.limitations),
      locations: [
        { kind: "artifact-path", path: report.artifact.selected_path },
      ],
      normalized_result: report,
    });
  }
});

it("preserves malformed fuse output ahead of late cancellation", async () => {
  const malformed = {
    ...report,
    artifact: { ...report.artifact, selected_path: "/artifacts/other" },
  };
  const controller = new AbortController();
  const invalid = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => {
      controller.abort();
      return ok(malformed);
    },
  }).inspect(
    { path: report.artifact.selected_path },
    { signal: controller.signal },
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error).toBeInstanceOf(AnalysisOutputError);
});

it("preserves caller-selected budgets and keeps omitted defaults out of Evidence parameters", async () => {
  const service = new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => ok(report),
  });
  const omitted = await service.inspect({
    path: report.artifact.selected_path,
  });
  expect(omitted.ok).toBe(true);
  if (omitted.ok) {
    expect(omitted.value.parameters).toEqual({
      path: report.artifact.selected_path,
    });
  }
  const explicit = await service.inspect({
    path: report.artifact.selected_path,
    max_file_bytes: 1024,
    max_sentinels_per_slice: 8,
    max_decoded_bytes: 4096,
  });
  expect(explicit.ok).toBe(true);
  if (explicit.ok) {
    expect(explicit.value.parameters).toEqual({
      path: report.artifact.selected_path,
      max_file_bytes: 1024,
      max_sentinels_per_slice: 8,
      max_decoded_bytes: 4096,
    });
  }
});

it("rejects provider reports that exceed caller-selected file or sentinel budgets", async () => {
  const oversized = {
    ...report,
    artifact: { ...report.artifact, bytes: 128 },
  };
  const fileResult = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => ok(oversized),
  }).inspect({ path: report.artifact.selected_path, max_file_bytes: 64 });
  expect(fileResult.ok).toBe(false);
  if (!fileResult.ok)
    expect(fileResult.error).toBeInstanceOf(AnalysisOutputError);

  const twoSentinels: ElectronFuseReport = {
    ...report,
    artifact: { ...report.artifact, bytes: 128 },
    slices: [
      {
        index: 0,
        file_offset: 0,
        size: 128,
        architecture: null,
        sentinel_count: 2,
        sentinels: [
          {
            sentinel_offset: 0,
            wire_version: 1,
            declared_length: 0,
            fuses: [],
            complete: true,
          },
          {
            sentinel_offset: 40,
            wire_version: 1,
            declared_length: 0,
            fuses: [],
            complete: true,
          },
        ],
      },
    ],
  };
  const sentinelResult = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => ok(twoSentinels),
  }).inspect({
    path: report.artifact.selected_path,
    max_sentinels_per_slice: 1,
  });
  expect(sentinelResult.ok).toBe(false);
  if (!sentinelResult.ok)
    expect(sentinelResult.error).toBeInstanceOf(AnalysisOutputError);

  const oversizedDefaultFile = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () =>
      ok({
        ...report,
        artifact: { ...report.artifact, bytes: 1073741825 },
      }),
  }).inspect({ path: report.artifact.selected_path });
  expect(oversizedDefaultFile.ok).toBe(false);
  if (!oversizedDefaultFile.ok) {
    expect(oversizedDefaultFile.error).toBeInstanceOf(AnalysisOutputError);
    expect(oversizedDefaultFile.error.message).toContain("budget");
  }

  const manyFuses: ElectronFuseReport = {
    ...report,
    artifact: { ...report.artifact, bytes: 128 },
    slices: [
      {
        index: 0,
        file_offset: 0,
        size: 128,
        architecture: null,
        sentinel_count: 1,
        sentinels: [
          {
            sentinel_offset: 0,
            wire_version: 2,
            declared_length: 8,
            fuses: Array.from({ length: 8 }, (_, index) => ({
              index,
              name: null,
              state: "enabled" as const,
              raw_byte: 0x31,
            })),
            complete: true,
          },
        ],
      },
    ],
  };
  const decodedResult = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => ok(manyFuses),
  }).inspect({
    path: report.artifact.selected_path,
    max_decoded_bytes: 1024,
  });
  expect(decodedResult.ok).toBe(false);
  if (!decodedResult.ok) {
    expect(decodedResult.error).toBeInstanceOf(AnalysisOutputError);
    expect(decodedResult.error.message).toContain("decoded-byte budget");
  }

  // Omitted max_decoded_bytes enforces the 8 MiB default across slices.
  const oversizedDefaultDecoded: ElectronFuseReport = {
    ...report,
    artifact: { ...report.artifact, bytes: 1000000 },
    slices: Array.from({ length: 128 }, (_, sliceIndex) => ({
      index: sliceIndex,
      file_offset: 0,
      size: 1000000,
      architecture: null,
      sentinel_count: 65,
      sentinels: Array.from({ length: 65 }, (_, sentinelIndex) => ({
        sentinel_offset: sentinelIndex * 64,
        wire_version: 2,
        declared_length: 0,
        fuses: [],
        complete: true,
      })),
    })),
  };
  const defaultDecodedResult = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () => ok(oversizedDefaultDecoded),
  }).inspect({
    path: report.artifact.selected_path,
    max_sentinels_per_slice: 1024,
  });
  expect(defaultDecodedResult.ok).toBe(false);
  if (!defaultDecodedResult.ok)
    expect(defaultDecodedResult.error).toBeInstanceOf(AnalysisOutputError);

  const thirtyThreeSentinels = Array.from({ length: 33 }, (_, i) => ({
    sentinel_offset: i * 40,
    wire_version: 1,
    declared_length: 0,
    fuses: [],
    complete: true,
  }));
  const oversizedDefaultSentinels = await new ElectronFuseService({
    identity,
    close: async () => {},
    inspect: async () =>
      ok({
        ...report,
        artifact: { ...report.artifact, bytes: 2048 },
        slices: [
          {
            index: 0,
            file_offset: 0,
            size: 2048,
            architecture: null,
            sentinel_count: 33,
            sentinels: thirtyThreeSentinels,
          },
        ],
      }),
  }).inspect({ path: report.artifact.selected_path });
  expect(oversizedDefaultSentinels.ok).toBe(false);
  if (!oversizedDefaultSentinels.ok)
    expect(oversizedDefaultSentinels.error).toBeInstanceOf(AnalysisOutputError);
});
