import { fileIdentity } from "../../../tests/fixtures/evidenceSubject.js";
import { createHash } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as discovery from "../../domain/rawRasterDiscovery.js";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { rawRasterDiscoverySchema } from "../../domain/native/rawRasterCandidates.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
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
  expect(result.ok).toBe(false);
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
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
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
