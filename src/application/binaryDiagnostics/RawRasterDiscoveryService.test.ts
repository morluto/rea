import { fileIdentity } from "../../../tests/fixtures/evidenceSubject.js";
import { createHash } from "node:crypto";
import { open, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as discovery from "../../domain/rawRasterDiscovery.js";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { rawRasterDiscoverySchema } from "../../domain/native/rawRasterCandidates.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { RawRasterDiscoveryService } from "./RawRasterDiscoveryService.js";
const grid = {
  widths: [32],
  heights: [16],
  formats: ["gray8"],
  offset_step: 16,
};
it("preserves whole-file digest, inferred confidence and absolute candidate offsets", async () => {
  const root = await createTestTempDirectory("rea-raster-");
  const path = join(root, "bytes");
  const bytes = Buffer.alloc(600);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 32; x++) bytes[33 + y * 32 + x] = x * 5 + y * 3;
  await writeFile(path, bytes);
  const service = new RawRasterDiscoveryService();
  try {
    const result = await service.inspect({
      path,
      offset: 33,
      length: 512,
      ...grid,
      offset_step: undefined,
    });
    if (!result.ok) throw result.error;
    const report = rawRasterDiscoverySchema.parse(
      result.value.normalized_result,
    );
    expect(report.candidates[0]?.layout.offset).toBe(33);
    expect(report.coverage.complete).toBe(true);
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.value.confidence).toBe("inferred");
    expect(fileIdentity(result.value.subject).sha256).toBe(
      report.artifact.sha256,
    );
  } finally {
    await service.close();
  }
});
it("rejects excessive selection and malformed grid before opening a file", async () => {
  let opens = 0;
  const service = new RawRasterDiscoveryService({
    stat,
    open: async (...args) => {
      opens++;
      return open(...args);
    },
  });
  for (const patch of [
    { length: 16777217 },
    { widths: [0] },
    { offset_step: 0 },
  ]) {
    const result = await service.inspect({ path: "/never-open", ...patch });
    expect(result.ok).toBe(false);
  }
  expect(opens).toBe(0);
  await service.close();
});
it("cancellation before acquisition and empty input never claim image absence", async () => {
  const root = await createTestTempDirectory("rea-raster-empty-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(0));
  const service = new RawRasterDiscoveryService();
  const controller = new AbortController();
  controller.abort();
  expect(
    (await service.inspect({ path }, { signal: controller.signal })).ok,
  ).toBe(false);
  expect((await service.inspect({ path })).ok).toBe(false);
  await service.close();
});
it("short reads are completed and a failed close retains its lease for retry", async () => {
  const root = await createTestTempDirectory("rea-raster-short-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(1024));
  let closes = 0;
  const service = new RawRasterDiscoveryService({
    stat,
    open: async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file),
        close = file.close.bind(file);
      Object.defineProperty(file, "read", {
        value: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => read(buffer, offset, Math.min(17, length), position),
      });
      Object.defineProperty(file, "close", {
        value: async () => {
          closes++;
          if (closes === 1) throw new Error("injected close failure");
          await close();
        },
      });
      return file;
    },
  });
  const result = await service.inspect({ path, ...grid });
  if (result.ok) throw Error("Expected close failure");
  expect(result.error.partialObservation).toMatchObject({
    operation: "inspect_raw_raster_candidates",
    normalized_result: {
      artifact: { path },
      candidates: expect.any(Array),
      coverage: expect.any(Object),
    },
  });
  await service.close();
  expect(closes).toBeGreaterThanOrEqual(2);
});

it("observes cancellation queued during synchronous scoring before publishing Evidence", async () => {
  const root = await createTestTempDirectory("rea-raster-cancel-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(1024));
  const controller = new AbortController();
  const original = discovery.discoverRawRaster;
  const spy = vi
    .spyOn(discovery, "discoverRawRaster")
    .mockImplementation((...args) => {
      const report = original(...args);
      setImmediate(() => controller.abort());
      return report;
    });
  const service = new RawRasterDiscoveryService();
  try {
    const result = await service.inspect(
      { path, ...grid },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.partialObservation).toMatchObject({
        operation: "inspect_raw_raster_candidates",
        normalized_result: { artifact: { path } },
      });
    }
  } finally {
    spy.mockRestore();
    await service.close();
  }
});

it.each(
  (["before", "after"] as const).flatMap((admission) =>
    (
      ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"] as const
    ).map((code) => ({ admission, code })),
  ),
)(
  "classifies $code $admission selected-file admission",
  async ({ admission, code }) => {
    const root = await createTestTempDirectory("rea-raster-errno-");
    const path = join(root, "bytes");
    await writeFile(path, Buffer.alloc(512));
    const cause = Object.assign(new Error(`injected ${code}`), { code });
    const fail = async (): Promise<never> => {
      throw cause;
    };
    const service = new RawRasterDiscoveryService({
      stat: admission === "before" ? fail : stat,
      open: fail,
    });
    try {
      const result = await service.inspect({ path, ...grid });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected selected-file failure");
      expect(result.error._tag).toBe(
        code === "EACCES" || code === "EPERM"
          ? "AnalysisAccessDeniedError"
          : admission === "before"
            ? "AnalysisInputError"
            : "AnalysisArtifactChangedError",
      );
    } finally {
      await service.close();
    }
  },
);

it("preserves an already typed provider failure by identity", async () => {
  const cause = new AnalysisInputError(
    "inspect_raw_raster_candidates",
    undefined,
    [
      {
        path: ["path"],
        reason: "invalid_value",
        message: "Injected typed failure.",
      },
    ],
  );
  const service = new RawRasterDiscoveryService({
    stat: async () => {
      throw cause;
    },
    open,
  });
  try {
    const result = await service.inspect({ path: "/typed-failure", ...grid });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected typed failure");
    expect(result.error).toBe(cause);
  } finally {
    await service.close();
  }
});

it("retains omitted controls separately from resolved analysis defaults", async () => {
  const root = await createTestTempDirectory("rea-raster-defaults-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(512));
  const service = new RawRasterDiscoveryService();
  try {
    const omitted = await service.inspect({ path });
    const explicit = await service.inspect({ path, max_candidates: 20 });
    if (!omitted.ok) throw omitted.error;
    if (!explicit.ok) throw explicit.error;
    expect(omitted.value.parameters).toEqual({ path });
    expect(explicit.value.parameters).toEqual({ path, max_candidates: 20 });
    expect(omitted.value.normalized_result).toMatchObject({
      resolved_controls: { max_candidates: 20, max_hypotheses: 20000 },
    });
  } finally {
    await service.close();
  }
});

it("reports deterministic acquisition ceilings without retryable capacity advice", async () => {
  const root = await createTestTempDirectory("rea-raster-ceilings-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(0));
  const service = new RawRasterDiscoveryService();
  try {
    for (const [size, expectedLimit] of [
      [128 * 1024 * 1024 + 1, 128 * 1024 * 1024],
      [16 * 1024 * 1024 + 1, 16 * 1024 * 1024],
    ] as const) {
      await truncate(path, size);
      const result = await service.inspect({ path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          _tag: "AnalysisResourceConstraintError",
          retryable: false,
        });
        if (result.error instanceof AnalysisResourceConstraintError)
          expect(result.error.recovery.fixedAllowance).toMatchObject({
            limit: expectedLimit,
            unit: "bytes",
          });
      }
    }
  } finally {
    await service.close();
  }
});

it("rejects incomplete resolved controls instead of inventing output defaults", async () => {
  const root = await createTestTempDirectory("rea-raster-resolved-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(512));
  const service = new RawRasterDiscoveryService();
  try {
    const result = await service.inspect({ path, max_hypotheses: 1 });
    if (!result.ok) throw result.error;
    const report = rawRasterDiscoverySchema.parse(
      result.value.normalized_result,
    );
    for (const key of Object.keys(report.resolved_controls)) {
      const controls = Object.fromEntries(
        Object.entries(report.resolved_controls).filter(
          ([name]) => name !== key,
        ),
      );
      expect(
        rawRasterDiscoverySchema.safeParse({
          ...report,
          resolved_controls: controls,
        }).success,
        key,
      ).toBe(false);
    }
  } finally {
    await service.close();
  }
});

it("close joins the whole inspection through final Evidence publication", async () => {
  const root = await createTestTempDirectory("rea-raster-close-publication-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(512));
  const events: string[] = [];
  let closing: Promise<void> | undefined;
  const service = new RawRasterDiscoveryService({
    stat,
    open: async (...args: Parameters<typeof open>) => {
      const file = await open(...args),
        close = file.close.bind(file);
      Object.defineProperty(file, "close", {
        value: async () => {
          await close();
          queueMicrotask(() => {
            closing = service.close().then(() => {
              events.push("close");
            });
          });
        },
      });
      return file;
    },
  });
  const result = await service.inspect({ path });
  events.push("inspect");
  await closing;
  expect(result.ok).toBe(true);
  expect(events).toEqual(["inspect", "close"]);
});

it("preserves the complete report when cancellation and close failure follow scoring", async () => {
  const root = await createTestTempDirectory("rea-report-cancel-close-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(1024));
  const controller = new AbortController();
  let closes = 0;
  const service = new RawRasterDiscoveryService({
    stat,
    open: async (...args) => {
      const file = await open(...args),
        close = file.close.bind(file);
      Object.defineProperty(file, "close", {
        value: async () => {
          if (++closes === 1) {
            controller.abort();
            throw Error("close failed");
          }
          await close();
        },
      });
      return file;
    },
  });
  try {
    const result = await service.inspect(
      { path, ...grid },
      { signal: controller.signal },
    );
    if (result.ok) throw Error("Expected cancellation and cleanup failure");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      operation: "inspect_raw_raster_candidates",
      normalized_result: {
        artifact: { path },
        candidates: expect.any(Array),
        coverage: expect.any(Object),
      },
    });
    expect(result.error.cleanupIncomplete).toBe(true);
    await service.close();
    expect(result.error.cleanupIncomplete).toBe(false);
  } finally {
    await service.close();
  }
});
