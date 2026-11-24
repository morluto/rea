import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createBinaryHardeningService } from "../../../src/composition/binaryDiagnostics/binaryHardening.js";
import { elfHardeningFixture } from "../../../src/native/hardening/BinaryHardening.fixture.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("binary hardening stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-files-");
    const path = join(root, "app");
    const alias = join(root, "alias");
    const bytes = elfHardeningFixture();
    await writeFile(path, bytes);
    await symlink(path, alias);
    const service = createBinaryHardeningService();
    try {
      for (const [candidate, reason] of [
        [root, "invalid_format"],
        [alias, "invalid_format"],
        [join(root, "missing"), "invalid_value"],
        [join(path, "child"), "invalid_value"],
      ] as const) {
        const result = await service.inspect({ path: candidate });
        if (result.ok) throw new Error("Expected file acquisition failure");
        expect(result.error).toMatchObject({
          _tag: "AnalysisInputError",
          operation: "inspect_binary_hardening",
          issues: [{ path: ["path"], reason, message: expect.any(String) }],
        });
      }
      const foreign = join(root, "foreign");
      await writeFile(foreign, Buffer.from("not a binary"));
      const unsupported = await service.inspect({ path: foreign });
      if (unsupported.ok) throw new Error("Expected an unsupported target");
      expect(unsupported.error._tag).toBe("AnalysisTargetFailureError");
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures and leaves bytes unchanged", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-budget-");
    const path = join(root, "app");
    const bytes = elfHardeningFixture();
    await writeFile(path, bytes);
    const service = createBinaryHardeningService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        format: "elf",
        images: [{ status: "parsed", architecture: "x86_64" }],
      });
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("reports the dynamic-table allowance in entries, not bytes", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-entries-");
    const path = join(root, "app");
    // A file-backed PT_DYNAMIC of 65,537 entries (16 bytes each in ELF64).
    const fixture = elfHardeningFixture();
    const bytes = Buffer.concat([fixture, Buffer.alloc(65_537 * 16)]);
    const programs = Number(bytes.readBigUInt64LE(32));
    const dynamic = Array.from(
      { length: bytes.readUInt16LE(56) },
      (_, index) => programs + index * bytes.readUInt16LE(54),
    ).find((at) => bytes.readUInt32LE(at) === 2);
    if (dynamic === undefined) throw new Error("Fixture has no PT_DYNAMIC");
    bytes.writeBigUInt64LE(BigInt(fixture.length), dynamic + 8);
    bytes.writeBigUInt64LE(65_537n * 16n, dynamic + 32);
    await writeFile(path, bytes);
    const service = createBinaryHardeningService();
    try {
      const result = await service.inspect({ path });
      if (result.ok) throw new Error("Expected the entry allowance refusal");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        fixedAllowance: { limit: 65_536, unit: "entries" },
      });
    } finally {
      await service.close();
    }
  });
});

describe("binary hardening compressed ELF names", () => {
  it("cancels a many-frame compressed section-name table", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-cancel-");
    const path = join(root, "app");
    await writeFile(path, elfFrameAllowanceFixture());
    const reason = new Error("stop hardening frames");
    const controller = new AbortController();
    const yieldImpl = scheduler.yield.bind(scheduler);
    let yields = 0;
    const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      yields += 1;
      await yieldImpl();
      if (yields === 1) controller.abort(reason);
    });
    const service = createBinaryHardeningService();
    try {
      const result = await service.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        operation: "inspect_binary_hardening",
        cause: reason,
      });
    } finally {
      spy.mockRestore();
      await service.close();
    }
  });
});
