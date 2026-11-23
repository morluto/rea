import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createElfDependenciesService } from "../../../src/composition/binaryDiagnostics/elfDependencies.js";
import { createElfNotesService } from "../../../src/composition/binaryDiagnostics/elfNotes.js";
import { createElfUnwindRangesService } from "../../../src/composition/binaryDiagnostics/elfUnwindRanges.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { elfDependencyFixture } from "../../../src/native/elf/ElfDependencies.fixture.js";
import { elfNoteFixture } from "../../../src/native/elf/ElfNotes.fixture.js";
import { elfUnwindFixture } from "../../../src/native/elf/ElfUnwindTables.fixture.js";
import {
  expectRetainedDescriptor,
  withDescriptorCloseFailure,
} from "../../fixtures/descriptorCloseFailure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock(import("node:fs/promises"), { spy: true });

it.each([
  {
    operation: "inspect_elf_notes",
    createService: createElfNotesService,
    fixture: elfNoteFixture,
    observed: {
      entries: expect.arrayContaining([
        expect.objectContaining({
          type_name: "gnu_build_id",
          gnu: expect.objectContaining({
            build_id_hex: "0123456789abcdef0123456789abcdef01234567",
          }),
        }),
      ]),
    },
  },
  {
    operation: "inspect_elf_dependencies",
    createService: createElfDependenciesService,
    fixture: elfDependencyFixture,
    observed: {
      needed: expect.arrayContaining([
        expect.objectContaining({ name: "libc.so.6" }),
      ]),
    },
  },
  {
    operation: "inspect_elf_unwind_ranges",
    createService: createElfUnwindRangesService,
    fixture: elfUnwindFixture,
    observed: {
      ranges: expect.arrayContaining([
        expect.objectContaining({ start: "0x400100", end: "0x400120" }),
      ]),
    },
  },
])(
  "$operation retains the verified report across descriptor close failure and retry",
  async ({ operation, createService, fixture, observed }) => {
    const path = join(
      await createTestTempDirectory("rea-elf-finalization-"),
      "source",
    );
    const bytes = fixture();
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const service = createService();
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
      const parameters = { path, max_file_bytes: bytes.length + 4096 };
      const result = await service.inspect(parameters);
      if (result.ok) throw new Error("Expected retained descriptor cleanup");
      expectRetainedDescriptor(result, cleanup, operation);
      const primary = primaryAnalysisError(result.error);
      const partial = result.error.partialObservation;
      const evidence = parseEvidence(partial);
      expect(evidence).toMatchObject({
        operation,
        parameters,
        subject: { identity: { format: "elf", sha256 }, local_path: path },
        normalized_result: {
          artifact: { path, bytes: bytes.length, sha256 },
          ...observed,
        },
      });
      if (operation === "inspect_elf_dependencies")
        expect(evidence.parameters).toEqual(parameters);
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
  },
);
