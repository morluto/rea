import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createPeRichHeaderService } from "../../../src/composition/binaryDiagnostics/peRichHeader.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  peRichHeaderImage,
  RICH_FIXTURE_ENTRIES,
} from "../../../src/native/pe/PeRichHeader.fixture.js";
import {
  expectRetainedDescriptor,
  withDescriptorCloseFailure,
} from "../../fixtures/descriptorCloseFailure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock(import("node:fs/promises"), { spy: true });

it("retains the verified Rich header report across descriptor close failure and retry", async () => {
  const path = join(
    await createTestTempDirectory("rea-pe-rich-finalization-"),
    "app.exe",
  );
  const bytes = peRichHeaderImage();
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const service = createPeRichHeaderService();
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
    expectRetainedDescriptor(result, cleanup, "inspect_pe_rich_header");
    const primary = primaryAnalysisError(result.error);
    const partial = result.error.partialObservation;
    expect(parseEvidence(partial)).toMatchObject({
      operation: "inspect_pe_rich_header",
      parameters: { path },
      subject: { identity: { format: "pe", sha256 }, local_path: path },
      normalized_result: {
        artifact: { path, bytes: bytes.length, sha256 },
        rich_header: {
          state: "present",
          checksum: { matches: true },
          entries: RICH_FIXTURE_ENTRIES.map(({ productId, build, count }) => ({
            product_id: productId,
            build,
            count,
          })),
        },
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
