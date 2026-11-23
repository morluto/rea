import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { runWithAnalysisOperationSnapshot } from "../../domain/analysisOperationSnapshot.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../../domain/analysisResourceLimits.js";
import { ElfNotesService } from "../../application/binaryDiagnostics/ElfNotesService.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analysisRefusalRemediation } from "../../domain/analysisRefusal.js";
import {
  elfNotesSchema,
  inspectElfNotesInputSchema,
} from "../../domain/native/elfNotes.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  compressedElfNoteFixture,
  elfNote,
  elfNoteFixture,
  elfNoteTablePastEnd,
} from "./ElfNotes.fixture.js";
import { ElfNotesProvider } from "./ElfNotesProvider.js";

const manyProductiveFrames = (count: number): Buffer => {
  const frame = zstdByteFrame(0x61);
  const bytes = Buffer.alloc(frame.length * count);
  for (let index = 0; index < count; index += 1)
    frame.copy(bytes, index * frame.length);
  return bytes;
};

const abortOnFirstYield = (reason: Error): AbortSignal => {
  const controller = new AbortController();
  const yieldImpl = scheduler.yield.bind(scheduler);
  let yields = 0;
  vi.spyOn(scheduler, "yield").mockImplementation(async () => {
    yields += 1;
    await yieldImpl();
    if (yields === 1) controller.abort(reason);
  });
  return controller.signal;
};

const inspect = async (
  path: string,
  input: { readonly max_file_bytes?: number } = {},
) => {
  const service = new ElfNotesService(new ElfNotesProvider());
  try {
    return await service.inspect({ path, ...input });
  } finally {
    await service.close();
  }
};

const zstdByteFrame = (byte: number): Buffer =>
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, byte]);

it("projects a Zstandard frame-cap on section names as an adjustable limit", async () => {
  const root = await createTestTempDirectory("rea-elf-note-zstd-frames-");
  const path = join(root, "notes.elf");
  await writeFile(
    path,
    compressedElfNoteFixture(
      64,
      true,
      2,
      ".note.gnu.build-id",
      Buffer.concat([zstdByteFrame(0x61), zstdByteFrame(0x62)]),
    ),
  );
  const result = await runWithAnalysisOperationSnapshot(
    { revision: 1, overrides: { "zstd.max_frames": 1 } },
    () => inspect(path),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "cpu",
    limit: {
      setting: "zstd.max_frames",
      effective_value: 1,
      source: "runtime",
      minimum: MINIMUM_ZSTD_MAX_FRAMES,
      maximum: MAXIMUM_ZSTD_MAX_FRAMES,
      unit: "count",
    },
  });
});

it("cancels a many-frame compressed section-name table", async () => {
  const root = await createTestTempDirectory("rea-elf-note-zstd-cancel-");
  const path = join(root, "notes.elf");
  await writeFile(
    path,
    compressedElfNoteFixture(
      64,
      true,
      2,
      ".note.gnu.build-id",
      manyProductiveFrames(32),
    ),
  );
  const reason = new Error("stop note frames");
  const provider = new ElfNotesProvider();
  const signal = abortOnFirstYield(reason);
  try {
    const result = await provider.inspect(
      inspectElfNotesInputSchema.parse({ path }),
      { signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "inspect_elf_notes",
      cause: reason,
    });
  } finally {
    vi.restoreAllMocks();
    await provider.close();
  }
});

describe("ELF note provider failures", () => {
  it("reports a note table past the end of the file as invalid input", async () => {
    const root = await createTestTempDirectory("rea-elf-note-past-end-");
    const path = join(root, "program");
    await writeFile(path, elfNoteTablePastEnd());
    const result = await inspect(path);
    if (result.ok) throw new Error("Expected invalid input");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["path"],
          reason: "invalid_format",
          message: expect.stringContaining("leaves the artifact"),
        },
      ],
    });
  });

  it("names the note text budget instead of host memory", async () => {
    const root = await createTestTempDirectory("rea-elf-note-text-budget-");
    const path = join(root, "program");
    const bytes = elfNoteFixture({
      ownership: "program",
      notes: elfNote("GNU", 3, Buffer.alloc(4096, 1)),
    });
    await writeFile(path, bytes);
    const result = await inspect(path);
    if (result.ok) throw new Error("Expected a text budget refusal");
    const error = result.error as AnalysisResourceConstraintError;
    expect(error.resource).toBe("memory");
    expect(error.reportedLimits).toEqual({
      boundary: "note_text_bytes",
      maximum: bytes.length,
    });
    expect(error.message).toMatch(/byte budget/u);
    const projected = projectAnalysisError(error);
    expect(projected.retryable).toBe(false);
    // The ceiling is the image length plus decoded section names; this
    // program-only fixture has no section names.
    expect(projected.details?.refusal).toMatchObject({
      kind: "fixed_ceiling",
      allowance_kind: "parser",
      limit: bytes.length,
      unit: "bytes",
    });
    expect(error.fixedAllowance).toBeDefined();
    expect(projected.remediation.action).toBe(
      analysisRefusalRemediation({
        kind: "fixed_ceiling",
        operation: "inspect_elf_notes",
        ceiling: error.fixedAllowance!,
      }),
    );
  });

  it("keeps a caller file-size budget distinct from host memory", async () => {
    const root = await createTestTempDirectory("rea-elf-note-file-budget-");
    const path = join(root, "program");
    await writeFile(path, elfNoteFixture({ ownership: "program" }));
    const result = await inspect(path, { max_file_bytes: 64 });
    if (result.ok) throw new Error("Expected a file-size refusal");
    const error = result.error as AnalysisResourceConstraintError;
    expect(error.resource).toBe("file-size");
    const projected = projectAnalysisError(error);
    expect(projected.retryable).toBe(false);
    expect(projected.remediation.action).toContain("max_file_bytes");
    expect(projected.remediation.action).not.toMatch(/available host memory/u);
  });

  it("reports and admits compressed names through max_file_bytes", async () => {
    const bytes = compressedElfNoteFixture();
    const sectionOffset = Number(bytes.readBigUInt64LE(40));
    const nameHeader = sectionOffset + bytes.readUInt16LE(62) * 64;
    const namesOffset = Number(bytes.readBigUInt64LE(nameHeader + 24));
    const decodedNamesBytes = Number(bytes.readBigUInt64LE(namesOffset + 8));
    const minimumMaxFileBytes = bytes.length + decodedNamesBytes;
    const root = await createTestTempDirectory("rea-elf-note-name-budget-");
    const path = join(root, "compressed-names.elf");
    await writeFile(path, bytes);

    const refused = await inspect(path, { max_file_bytes: bytes.length + 1 });
    if (refused.ok) throw new Error("Expected section-name admission refusal");
    expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(refused.error instanceof AnalysisResourceConstraintError))
      throw refused.error;
    expect(refused.error).toMatchObject({
      resource: "memory",
      reportedLimits: {
        boundary: "max_file_bytes",
        maximum: bytes.length + 1,
        required: String(minimumMaxFileBytes),
      },
      retryable: false,
    });
    expect(projectAnalysisError(refused.error).remediation.action).toContain(
      "max_file_bytes",
    );

    const admitted = await inspect(path, {
      max_file_bytes: minimumMaxFileBytes,
    });
    if (!admitted.ok) throw admitted.error;
    const report = elfNotesSchema.parse(admitted.value.normalized_result);
    expect(report.tables[0]?.name).toBe(".note.gnu.build-id");
  });
});
