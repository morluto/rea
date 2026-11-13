import { symlink, writeFile } from "node:fs/promises";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UnrealPakService } from "../../../src/application/unreal/UnrealPakService.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { UnrealPakProvider } from "../../../src/unreal/UnrealPakProvider.js";
import { createPakFixture } from "../../fixtures/unreal/pak.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fixedAllowanceRemediation } from "../../../src/domain/fixedAllowanceRemediation.js";

const writePak = async (name: string, bytes: Buffer) => {
  const root = await createTestTempDirectory("rea-unreal-provider-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return { root, path };
};

it("refuses a report above the output budget from the entry count, before entries exist", async () => {
  const { path } = await writePak(
    "big.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const provider = new UnrealPakProvider(100);
  const result = await provider.inspect({ path });
  await provider.close();
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({
      message: expect.stringContaining("exceeds the inline output budget"),
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("counts the escaped mount point toward the budget without escaping it", async () => {
  // 4 KiB of U+0001 is 4 KiB in the index but 24 KiB once escaped as .
  const { path } = await writePak(
    "mount.pak",
    createPakFixture({
      layout: "v11",
      files: [],
      mountPoint: "".repeat(4096),
    }).bytes,
  );
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new UnrealPakProvider(8192);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) => typeof value === "object" && value !== null,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it("admits a report whose escaped mount point fits the budget exactly", async () => {
  const { path } = await writePak(
    "fit.pak",
    createPakFixture({
      layout: "v11",
      mountPoint: "".repeat(4096),
    }).bytes,
  );
  const unbounded = new UnrealPakProvider();
  let bytes: number;
  try {
    const result = await unbounded.inspect({ path });
    if (!result.ok) throw result.error;
    bytes = Buffer.byteLength(JSON.stringify(result.value));
  } finally {
    await unbounded.close();
  }
  const exact = new UnrealPakProvider(bytes);
  try {
    expect((await exact.inspect({ path })).ok).toBe(true);
  } finally {
    await exact.close();
  }
});

it("rejects a symlink instead of following it", async () => {
  const { root, path } = await writePak(
    "real.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const link = join(root, "link.pak");
  await symlink(path, link);
  const provider = new UnrealPakProvider();
  const result = await provider.inspect({ path: link });
  await provider.close();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toMatch(/symlink|invalid/iu);
});

it("refuses relative paths and unretained summaries before reading", async () => {
  const service = new UnrealPakService(new UnrealPakProvider());
  const relative = await service.inspect({ path: "Game.pak" });
  expect(relative.ok).toBe(false);
  const { path } = await writePak(
    "ok.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  // Omitted detail is summary, which needs retention.
  const summary = await service.inspect({ path });
  expect(summary.ok).toBe(false);
  const complete = await service.inspect({ path, detail: "complete" });
  expect(complete.ok && complete.value.operation).toBe("inspect_unreal_pak");
  await service.close();
});

it("keeps the decoded report when cancellation arrives after a complete read", async () => {
  const { path } = await writePak(
    "late.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const provider = new UnrealPakProvider();
  const controller = new AbortController();
  const reason = new Error("late cancellation");
  const service = new UnrealPakService({
    identity: provider.identity,
    inspect: async (input, options) => {
      const inspected = await provider.inspect(input, options);
      controller.abort(reason);
      return inspected;
    },
  });
  const result = await service.inspect(
    { path, detail: "complete" },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.partialObservation).toMatchObject({
    operation: "inspect_unreal_pak",
    normalized_result: { artifact: { path }, footer: { layout: "v11" } },
  });
  await provider.close();
});

it("admits one inspection at a time per reader", async () => {
  const { path } = await writePak(
    "busy.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const provider = new UnrealPakProvider();
  const first = provider.inspect({ path });
  const second = await provider.inspect({ path });
  expect(second.ok).toBe(false);
  if (!second.ok)
    expect(second.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect((await first).ok).toBe(true);
  expect((await provider.inspect({ path })).ok).toBe(true);
  await provider.close();
});

it.each(["v7", "v11"] as const)(
  "yields during a long %s entry decode and stops there when cancelled",
  async (layout) => {
    const files = Array.from({ length: 3 * 4096 }, (_, at) => ({
      path: `D/${at}`,
      size: 0,
    }));
    const { path } = await writePak(
      "long.pak",
      createPakFixture({ layout, files }).bytes,
    );
    let yields = 0;
    const complete = new UnrealPakProvider(undefined, async () => {
      yields++;
    });
    const decoded = await complete.inspect({ path });
    expect(decoded.ok && decoded.value.entries).toHaveLength(files.length);
    expect(yields).toBeGreaterThanOrEqual(2);
    await complete.close();

    const controller = new AbortController();
    const reason = new Error("cancel during entry decode");
    let paused = 0;
    const provider = new UnrealPakProvider(undefined, async () => {
      paused++;
      controller.abort(reason);
    });
    const result = await provider.inspect(
      { path },
      { signal: controller.signal },
    );
    expect(paused).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    // The whole-file hash had not completed, so no source identity is claimed.
    expect(result.error.partialObservation).toBeUndefined();
    await provider.close();
  },
);

it("reports the path budget, not a file size, when path text exceeds it", async () => {
  const { path } = await writePak(
    "paths.pak",
    createPakFixture({
      layout: "v11",
      files: [],
      mountPoint: "M".repeat(4096),
    }).bytes,
  );
  const provider = new UnrealPakProvider(2048);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        resource: "transport",
        reportedLimits: {
          maximum_output_bytes: 2048,
          maximum_path_utf16_units: 2048,
        },
      });
    // An early refusal leaves no Evidence, and complete CLI JSON uses the same
    // allowance, so the recovery names the fixed value instead of either.
    if (!result.ok)
      expect(projectAnalysisError(result.error)).toMatchObject({
        retryable: false,
        remediation: {
          action: fixedAllowanceRemediation(
            "The Unreal pak complete-report allowance of 2048 bytes (this release has no runtime override)",
            "report",
          ),
        },
      });
  } finally {
    await provider.close();
  }
});
