import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createPeUnwindRangesService } from "../../../src/composition/binaryDiagnostics/peUnwindRanges.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  peUnwindImage,
  unwindInfo,
} from "../../../src/native/pe/PeUnwindRanges.fixture.js";
import {
  expectRetainedDescriptor,
  withDescriptorCloseFailure,
} from "../../fixtures/descriptorCloseFailure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock(import("node:fs/promises"), { spy: true });

it("retains the verified exception-directory report across descriptor close failure and retry", async () => {
  const path = join(
    await createTestTempDirectory("rea-pe-unwind-finalization-"),
    "app.exe",
  );
  const bytes = peUnwindImage({
    entries: [{ begin: 0x1000, end: 0x1100, unwind: 0x2000 }],
    blobs: [{ rva: 0x2000, bytes: unwindInfo(0, 2) }],
  });
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const service = createPeUnwindRangesService();
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
    expectRetainedDescriptor(result, cleanup, "inspect_pe_unwind_ranges");
    const primary = primaryAnalysisError(result.error);
    const partial = result.error.partialObservation;
    expect(parseEvidence(partial)).toMatchObject({
      operation: "inspect_pe_unwind_ranges",
      subject: { identity: { format: "pe", sha256 }, local_path: path },
      normalized_result: {
        artifact: { path, bytes: bytes.length, sha256 },
        coverage: { total_entries: 1, primary_entries: 1 },
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
