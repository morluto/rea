import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createBinaryHardeningService } from "../../../src/composition/binaryDiagnostics/binaryHardening.js";
import { createElfUnwindRangesService } from "../../../src/composition/binaryDiagnostics/elfUnwindRanges.js";
import { createNativeExportsService } from "../../../src/composition/binaryDiagnostics/nativeExports.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  [
    "inspect_binary_hardening",
    createBinaryHardeningService,
    { format: "elf", images: [{ status: "parsed" }] },
  ],
  ["inspect_elf_unwind_ranges", createElfUnwindRangesService, {}],
  ["inspect_native_exports", createNativeExportsService, { format: "elf" }],
] as const)(
  "%s observes cancellation while decoding ELF names after the file snapshot closes",
  async (operation, createService, expectedReport) => {
    const root = await createTestTempDirectory("rea-elf-names-cancel-");
    const path = join(root, "app");
    const bytes = elfFrameAllowanceFixture();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    const service = createService();
    const controller = new AbortController();
    const reason = new Error("stop section-name decoding");
    const yieldToEventLoop = scheduler.yield.bind(scheduler);
    const pause = vi
      .spyOn(scheduler, "yield")
      .mockImplementationOnce(async () => {
        await yieldToEventLoop();
        controller.abort(reason);
      });
    try {
      const result = await service.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        operation,
        cause: reason,
        partialObservation: {
          kind: "file-snapshot-hash",
          path,
          sha256,
          bytes: bytes.length,
        },
      });
      const retry = await service.inspect(
        { path },
        { signal: new AbortController().signal },
      );
      if (!retry.ok) throw retry.error;
      expect(retry.value.normalized_result).toMatchObject({
        artifact: { path, sha256, bytes: bytes.length },
        ...expectedReport,
      });
      expect((await readFile(path)).equals(bytes)).toBe(true);
    } finally {
      pause.mockRestore();
      await service.close();
    }
  },
);
