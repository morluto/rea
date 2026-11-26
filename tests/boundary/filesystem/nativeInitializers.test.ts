import { createHash } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createNativeInitializersService } from "../../../src/composition/binaryDiagnostics/nativeInitializers.js";
import {
  elf64PieInitializers,
  machoInitializerSymbolKinds,
} from "../../../src/native/initializers/NativeInitializers.fixture.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("native initializer stable filesystem boundary", () => {
  it.each([
    { kind: "N_INDR", type: 0x0a, symbol: "_startup" },
    { kind: "N_PBUD", type: 0x0c, symbol: "_startup" },
    { kind: "N_ABS", type: 0x02, symbol: "_alias" },
    { kind: "N_SECT", type: 0x0e, symbol: "_alias" },
  ])(
    "uses address-bearing symbols for initializer names ($kind)",
    async ({ type, symbol }) => {
      const root = await createTestTempDirectory("rea-native-init-symbol-");
      const path = join(root, "program.o");
      await writeFile(path, machoInitializerSymbolKinds(type));
      const result = await createNativeInitializersService().inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        format: "mach-o",
        entries: [
          {
            value_va: "0x10",
            symbol: { name: "_startup", trust: "observed-untrusted" },
            resolution: "symbol_addend",
          },
          {
            value_va: "0x10",
            symbol: { name: symbol, trust: "observed-untrusted" },
            resolution: "raw",
          },
        ],
        coverage: { status: "complete", returned_entries: 2 },
      });
    },
  );

  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-native-init-files-");
    const path = join(root, "program");
    const alias = join(root, "alias");
    await writeFile(path, elf64PieInitializers());
    await symlink(path, alias);
    const service = createNativeInitializersService();
    await expectFileSelectionErrors(service, "inspect_native_initializers", {
      root,
      alias,
      path,
    });
  });

  it("reads a stable file and returns typed budget and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-native-init-budget-");
    const path = join(root, "program");
    await writeFile(path, elf64PieInitializers());
    const service = createNativeInitializersService();
    const read = await service.inspect({ path });
    if (!read.ok) throw read.error;
    expect(read.value).toMatchObject({
      operation: "inspect_native_initializers",
      provider: { id: "rea-native-initializers" },
      normalized_result: { format: "elf", status: "parsed" },
    });
    const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});

it("cancels ELF section-name decoding while retaining the initializer snapshot", async () => {
  const root = await createTestTempDirectory("rea-native-init-zstd-cancel-");
  const path = join(root, "program");
  const bytes = elfFrameAllowanceFixture();
  await writeFile(path, bytes);
  const service = createNativeInitializersService();
  const controller = new AbortController();
  const reason = new Error("section-name reading cancelled");
  const nativeYield = scheduler.yield.bind(scheduler);
  const pause = vi
    .spyOn(scheduler, "yield")
    .mockImplementationOnce(async () => {
      await nativeYield();
      controller.abort(reason);
    });
  try {
    const result = await service.inspect(
      { path },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation during ELF names");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
      partialObservation: {
        kind: "file-snapshot-hash",
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
    });
    const retry = await service.inspect({ path });
    if (!retry.ok) throw retry.error;
    expect(retry.value.normalized_result).toMatchObject({
      format: "elf",
      status: "parsed",
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  } finally {
    pause.mockRestore();
    await service.close();
  }
});
