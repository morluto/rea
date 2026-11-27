import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createMachoFunctionStartsService } from "../../../src/composition/binaryDiagnostics/machoFunctionStarts.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { arm64FunctionStartsImage } from "../../../src/native/apple/MachoFunctionStarts.fixture.js";
import {
  expectRetainedDescriptor,
  withDescriptorCloseFailure,
} from "../../fixtures/descriptorCloseFailure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock(import("node:fs/promises"), { spy: true });

it("retains the verified function-start report across descriptor close failure and retry", async () => {
  const path = join(
    await createTestTempDirectory("rea-macho-function-starts-finalization-"),
    "program",
  );
  const bytes = arm64FunctionStartsImage();
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const service = createMachoFunctionStartsService();
  const real =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const cleanup: Parameters<typeof withDescriptorCloseFailure>[1] = {
    path,
    denied: true,
    handles: [],
  };
  const openFile = vi.mocked(open);
  openFile.mockImplementation(withDescriptorCloseFailure(real, cleanup).open);
  try {
    const result = await service.inspect({ path });
    if (result.ok) throw new Error("Expected retained descriptor cleanup");
    expectRetainedDescriptor(result, cleanup, "inspect_macho_function_starts");
    const primary = primaryAnalysisError(result.error);
    const partial = result.error.partialObservation;
    expect(parseEvidence(partial)).toMatchObject({
      operation: "inspect_macho_function_starts",
      subject: { identity: { format: "mach-o", sha256 }, local_path: path },
      normalized_result: {
        artifact: { path, bytes: bytes.length, sha256 },
        coverage: { total_starts: 3, total_data_in_code: 3 },
      },
    });
    cleanup.denied = false;
    await service.close();
    expect(cleanup.handles[0]?.fd).toBe(-1);
    expect(result.error.cleanupResources).toEqual([]);
    expect(resolvedAnalysisError(result.error)).toBe(primary);
    expect(primary.partialObservation).toBe(partial);
  } finally {
    cleanup.denied = false;
    openFile.mockReset();
    await service.close();
  }
});
