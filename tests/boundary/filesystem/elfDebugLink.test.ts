import * as zlib from "node:zlib";
import { sha256 as sha256Of } from "../../support/sha256.js";
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createElfDebugLinkService } from "../../../src/composition/binaryDiagnostics/elfDebugLink.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_COMPARISON_INCOMPLETE_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
  elfDebugLinkSchema,
} from "../../../src/domain/native/elfDebugLink.js";
import {
  compressedElfNoteFixture,
  gnuBuildIdNote,
} from "../../../src/native/elf/ElfNotes.fixture.js";
import {
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
} from "../../../src/native/elf/ElfDebugLink.fixture.js";
import {
  expectRetainedDescriptor,
  withDescriptorCloseFailure,
} from "../../fixtures/descriptorCloseFailure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";

vi.mock(import("node:zlib"), { spy: true });
vi.mock(import("node:fs/promises"), { spy: true });

it("inflates section names once per artifact while preserving build-ID comparison", async () => {
  const root = await createTestTempDirectory("rea-elf-debug-link-name-reuse-");
  const path = join(root, "prog");
  const candidatePath = join(root, "prog.debug");
  const bytes = compressedElfNoteFixture();
  await writeFile(path, bytes);
  await writeFile(candidatePath, bytes);
  const service = createElfDebugLinkService();
  const inflate = vi.mocked(zlib.inflateSync).mockClear();
  try {
    const result = await service.inspect(
      { path, candidate_path: candidatePath },
      { signal: new AbortController().signal },
    );
    if (!result.ok) throw result.error;
    const report = elfDebugLinkSchema.parse(result.value.normalized_result);
    expect(report.build_id).toMatchObject({
      status: "observed",
      sources: [{ table_kind: "section", table_index: 1 }],
    });
    expect(report.verification?.build_id.status).toBe("match");
    expect(inflate).toHaveBeenCalledTimes(2);
  } finally {
    inflate.mockClear();
    await service.close();
  }
});

describe("ELF debug-link stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-files-");
    const path = join(root, "prog");
    const alias = join(root, "alias");
    await writeFile(path, elfDebugLinkFixture());
    await symlink(path, alias);
    const service = createElfDebugLinkService();
    try {
      await expectFileSelectionErrors(service, "inspect_elf_debug_link", {
        root,
        alias,
        path,
      });
    } finally {
      await service.close();
    }
  });

  it("keeps the image linkage for a missing candidate and rejects symlinked or relative candidates", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-candidate-");
    const path = join(root, "prog");
    const alias = join(root, "alias.debug");
    const image = elfDebugLinkFixture();
    await writeFile(path, image);
    await symlink(path, alias);
    const service = createElfDebugLinkService();
    try {
      const missing = await service.inspect({
        path,
        candidate_path: join(root, "missing.debug"),
      });
      if (!missing.ok) throw missing.error;
      const report = elfDebugLinkSchema.parse(missing.value.normalized_result);
      expect(report.artifact).toEqual({
        path,
        sha256: sha256Of(image),
        bytes: image.length,
      });
      expect(report.debuglink).toMatchObject({
        status: "present",
        filename: { text: FIXTURE_DEBUG_NAME },
        crc32_hex: "12345678",
      });
      expect(report.build_id.hex).toBe(FIXTURE_BUILD_ID_HEX);
      expect(report.lookup_paths).toContainEqual({
        kind: "debug_subdirectory",
        path: join(root, ".debug", FIXTURE_DEBUG_NAME),
        trust: "observed-untrusted",
      });
      expect(report.limitations).toEqual(
        expect.arrayContaining([
          ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
          ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
        ]),
      );
      expect(report.candidate).toBeNull();
      expect(report.verification).toEqual({
        status: "cannot_verify",
        reason: "candidate_unreadable",
        crc32: {
          status: "unavailable",
          expected_hex: "12345678",
          observed_hex: null,
          reason: "candidate_unreadable",
        },
        build_id: {
          status: "unavailable",
          binary_hex: FIXTURE_BUILD_ID_HEX,
          candidate_hex: null,
          reason: "candidate_unreadable",
        },
      });
      for (const candidate_path of [alias, "prog.debug"]) {
        const refusal = await service.inspect({ path, candidate_path });
        if (refusal.ok)
          throw new Error(`Expected refusal for ${candidate_path}`);
        expect(refusal.error).toMatchObject({
          _tag: "AnalysisInputError",
          issues: [{ path: ["candidate_path"], reason: "invalid_format" }],
        });
      }
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-budget-");
    const path = join(root, "prog");
    const notes = Buffer.concat([
      gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
      gnuBuildIdNote("bb".repeat(20), true),
    ]);
    await writeFile(path, elfDebugLinkFixture({ notes }));
    const service = createElfDebugLinkService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      expect(projectAnalysisError(tooSmall.error).details).toMatchObject({
        limit: {
          control_kind: "parameter",
          parameter: "max_file_bytes",
          effective_value: 64,
          minimum: 64,
          maximum: 536870912,
          default_value: 67108864,
        },
      });
      const tooMany = await service.inspect({ path, max_entries: 1 });
      if (tooMany.ok) throw new Error("Expected entry budget failure");
      if (!(tooMany.error instanceof AnalysisResourceConstraintError))
        throw new Error("Expected entry budget failure");
      expect(tooMany.error.remediationAction).toContain("smaller image");
      expect(tooMany.error.limit).toEqual({
        control_kind: "parameter",
        parameter: "max_entries",
        effective_value: 1,
        unit: "count",
        minimum: 1,
        maximum: 256,
        default_value: 128,
        applies_at: "next_call",
      });
      expect((await service.inspect({ path, max_entries: 2 })).ok).toBe(true);
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    } finally {
      await service.close();
    }
  });
});

it("does not open a conventional lookup path when no candidate is selected", async () => {
  const root = await createTestTempDirectory("rea-elf-debug-link-decoy-");
  const path = join(root, "prog");
  const decoy = join(root, ".debug", FIXTURE_DEBUG_NAME);
  await writeFile(path, elfDebugLinkFixture());
  await mkdir(join(root, ".debug"));
  await writeFile(decoy, elfDebugCandidateFixture());

  const service = createElfDebugLinkService();
  try {
    vi.mocked(open).mockClear();
    const result = await service.inspect({ path });
    if (!result.ok) throw result.error;
    const selectedPaths = vi
      .mocked(open)
      .mock.calls.map(([selected]) => selected);
    expect(selectedPaths).toContain(path);
    expect(selectedPaths).not.toContain(decoy);
    const report = elfDebugLinkSchema.parse(result.value.normalized_result);
    expect(report.lookup_paths).toContainEqual({
      kind: "debug_subdirectory",
      path: decoy,
      trust: "observed-untrusted",
    });
    expect(report.verification).toBeNull();
    expect(report.candidate).toBeNull();
    expect(report.debuglink.status).toBe("present");
  } finally {
    await service.close();
  }
});

it.each(["comparison", "descriptor close", "failed descriptor close"] as const)(
  "retains streamed candidate Evidence when cancelled during %s",
  async (stage) => {
    const root = await createTestTempDirectory(
      "rea-elf-debug-link-cancel-candidate-",
    );
    const path = join(root, "prog");
    const candidatePath = join(root, "prog.debug");
    const candidateFixture = elfFrameAllowanceFixture();
    const image = elfDebugLinkFixture();
    const closing = stage !== "comparison";
    const closeFailed = stage === "failed descriptor close";
    const candidate = closing
      ? Buffer.concat([candidateFixture, Buffer.alloc(160_000)])
      : candidateFixture;
    const parameters = {
      path,
      candidate_path: candidatePath,
      ...(closing ? { max_file_bytes: image.length } : {}),
    };
    await writeFile(path, image);
    await writeFile(candidatePath, candidate);
    const service = createElfDebugLinkService();
    const controller = new AbortController();
    const reason = new Error(`stop during the candidate ${stage}`);
    const yieldToEventLoop = scheduler.yield.bind(scheduler);
    const pause = vi.spyOn(scheduler, "yield");
    const openFile = vi.mocked(open);
    if (stage === "comparison") {
      pause.mockImplementationOnce(async () => {
        await yieldToEventLoop();
        controller.abort(reason);
      });
    } else {
      const real =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      openFile.mockImplementation(async (...args) => {
        const handle = await real.open(...args);
        if (args[0] === candidatePath) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            if (!closeFailed) await close();
            controller.abort(reason);
            if (closeFailed)
              throw new Error("candidate descriptor not released");
          });
        }
        return handle;
      });
    }
    try {
      const result = await service.inspect(parameters, {
        signal: controller.signal,
      });
      if (result.ok)
        throw new Error("Expected candidate comparison cancellation");
      const primary = primaryAnalysisError(result.error);
      expect(primary._tag).toBe("AnalysisCancelledError");
      expect(primary.cause).toBe(reason);
      expect(result.error.cleanupIncomplete).toBe(closeFailed);
      expect(result.error.cleanupResources).toEqual(
        closeFailed ? [candidatePath] : [],
      );
      const evidence = parseEvidence(result.error.partialObservation);
      expect(evidence.parameters).toEqual(parameters);
      expect(evidence.subject).toMatchObject({
        identity: {
          kind: "file",
          format: "elf",
          sha256: sha256Of(image),
        },
        local_path: path,
      });
      expect(evidence.locations.slice(0, 2)).toEqual([
        { kind: "artifact-path", path },
        { kind: "artifact-path", path: candidatePath },
      ]);
      const report = elfDebugLinkSchema.parse(evidence.normalized_result);
      expect(report.build_id).toMatchObject({
        status: "observed",
        hex: FIXTURE_BUILD_ID_HEX,
      });
      expect(report.candidate).toEqual({
        path: candidatePath,
        sha256: sha256Of(candidate),
        bytes: candidate.length,
        format: null,
        byte_order: null,
        debug_info: "unknown",
        symtab: "unknown",
      });
      expect(report.verification).toBeNull();
      expect(report.limitations).toContain(
        ELF_DEBUG_LINK_CANDIDATE_COMPARISON_INCOMPLETE_LIMITATION,
      );
      if (closeFailed) {
        await service.close();
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(result.error.cleanupResources).toEqual([]);
        expect(resolvedAnalysisError(result.error)).toBe(primary);
        expect(parseEvidence(primary.partialObservation)).toEqual(evidence);
      }
    } finally {
      pause.mockRestore();
      openFile.mockReset();
      await service.close();
    }
  },
);
it.each([
  "image close failure",
  "cancellation during image close",
  "candidate close failure",
] as const)("retains completed ELF Evidence after %s", async (stage) => {
  const root = await createTestTempDirectory(
    "rea-elf-debug-link-finalization-",
  );
  const path = join(root, "prog");
  const candidatePath = join(root, "prog.debug");
  const candidate = elfDebugCandidateFixture();
  const crc = zlib.crc32(candidate);
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, crc, true),
  });
  await writeFile(path, image);
  await writeFile(candidatePath, candidate);

  const service = createElfDebugLinkService();
  const controller = new AbortController();
  const cancelAtClose = stage === "cancellation during image close";
  const candidateCompleted = stage === "candidate close failure";
  const reason = new Error(stage);
  const cleanup: Parameters<typeof withDescriptorCloseFailure>[1] = {
    path: candidateCompleted ? candidatePath : path,
    denied: !cancelAtClose,
    handles: [],
  };
  const openFile = vi.mocked(open);
  const real =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const injected = withDescriptorCloseFailure(real, cleanup);
  openFile.mockImplementation(async (...args) => {
    const handle = await injected.open(...args);
    if (cancelAtClose && args[0] === path) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        controller.abort(reason);
      });
    }
    return handle;
  });
  const parameters = cancelAtClose
    ? { path }
    : { path, candidate_path: candidatePath };
  try {
    const result = await service.inspect(parameters, {
      signal: controller.signal,
    });
    if (result.ok)
      throw new Error("Expected ELF descriptor finalization failure");
    const primary = primaryAnalysisError(result.error);
    if (cancelAtClose) {
      expect(primary._tag).toBe("AnalysisCancelledError");
      expect(primary.cause).toBe(reason);
      expect(result.error.cleanupResources).toEqual([]);
    } else {
      expectRetainedDescriptor(result, cleanup, "inspect_elf_debug_link");
    }
    expect(
      openFile.mock.calls.some(([selected]) => selected === candidatePath),
    ).toBe(candidateCompleted);

    const evidence = parseEvidence(result.error.partialObservation);
    expect(evidence.parameters).toEqual(parameters);
    const report = elfDebugLinkSchema.parse(evidence.normalized_result);
    expect(report).toMatchObject({
      artifact: { path, bytes: image.length, sha256: sha256Of(image) },
      debuglink: {
        status: "present",
        crc32_hex: crc.toString(16).padStart(8, "0"),
      },
      build_id: { status: "observed", hex: FIXTURE_BUILD_ID_HEX },
      candidate: candidateCompleted
        ? {
            path: candidatePath,
            bytes: candidate.length,
            format: "elf64",
            sha256: sha256Of(candidate),
          }
        : null,
      verification: candidateCompleted
        ? {
            status: "matches",
            crc32: { status: "match" },
            build_id: { status: "match" },
          }
        : null,
    });
    expect(
      report.limitations.includes(
        ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
      ),
    ).toBe(!cancelAtClose && !candidateCompleted);
    cleanup.denied = false;
    await service.close();
    expect(cleanup.handles[0]?.fd).toBe(-1);
    expect(result.error.cleanupResources).toEqual([]);
    expect(resolvedAnalysisError(result.error)).toBe(primary);
    expect(parseEvidence(primary.partialObservation)).toEqual(evidence);
  } finally {
    cleanup.denied = false;
    openFile.mockReset();
    await service.close();
  }
});

it("does not promote parsed linkage when the image changes before final verification", async () => {
  const root = await createTestTempDirectory(
    "rea-elf-debug-link-final-identity-",
  );
  const path = join(root, "prog");
  const image = elfDebugLinkFixture({ debugdata: Buffer.alloc(8192) });
  const namesOffset = image.indexOf(Buffer.from("\0.note.gnu.build-id\0"));
  expect(namesOffset).toBeGreaterThan(4096);
  await writeFile(path, image);

  const service = createElfDebugLinkService();
  const openFile = vi.mocked(open);
  const real =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let changed = false;
  openFile.mockImplementation(async (...args) => {
    const handle = await real.open(...args);
    if (args[0] === path) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...range) => {
        const result = await read(...range);
        if (!changed && range.at(3) === namesOffset && result.bytesRead > 0) {
          await real.appendFile(path, Buffer.of(0));
          changed = true;
        }
        return result;
      });
    }
    return handle;
  });
  try {
    const result = await service.inspect({ path });
    expect(changed).toBe(true);
    if (result.ok)
      throw new Error("Expected the final identity check to refuse the image");
    expect(projectAnalysisError(result.error).code).toBe("artifact_changed");
    expect(result.error.partialObservation).toMatchObject({
      path,
      bytes: image.length,
      sha256: sha256Of(image),
    });
  } finally {
    openFile.mockReset();
    await service.close();
  }
});

describe("ELF debug-link streamed candidate boundary", () => {
  it("matches the known CRC32 of a non-ELF candidate", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-crc32-");
    const path = join(root, "prog");
    const candidatePath = join(root, FIXTURE_DEBUG_NAME);
    await writeFile(
      path,
      elfDebugLinkFixture({
        debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0xcbf43926, true),
      }),
    );
    await writeFile(candidatePath, "123456789");
    const service = createElfDebugLinkService();
    try {
      const result = await service.inspect({
        path,
        candidate_path: candidatePath,
      });
      if (!result.ok) throw result.error;
      const report = elfDebugLinkSchema.parse(result.value.normalized_result);
      expect(report.candidate).toMatchObject({
        format: null,
        byte_order: null,
        debug_info: "not_elf",
        symtab: "not_elf",
      });
      expect(report.verification).toMatchObject({
        status: "matches",
        crc32: { status: "match", observed_hex: "cbf43926" },
        build_id: { status: "unavailable", reason: "candidate_not_elf" },
      });
      expect(report.limitations).toContain(
        ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
      );
    } finally {
      await service.close();
    }
  });

  it("streams a candidate larger than the image read budget", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-stream-");
    // Trailing padding keeps the ELF header while exceeding several chunks.
    const candidate = Buffer.concat([
      elfDebugCandidateFixture(),
      Buffer.alloc(200_000, 0x5a),
    ]);
    const image = elfDebugLinkFixture({
      debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0x5f6d3801, true),
    });
    const path = join(root, "prog");
    const candidatePath = join(root, FIXTURE_DEBUG_NAME);
    await writeFile(path, image);
    await writeFile(candidatePath, candidate);
    const service = createElfDebugLinkService();
    try {
      const result = await service.inspect({
        path,
        candidate_path: candidatePath,
        max_file_bytes: image.length,
      });
      if (!result.ok) throw result.error;
      const report = elfDebugLinkSchema.parse(result.value.normalized_result);
      expect(candidate.length).toBeGreaterThan(image.length);
      expect(report.candidate).toMatchObject({
        bytes: candidate.length,
        format: "elf64",
        byte_order: "little",
        debug_info: "unknown",
        symtab: "unknown",
      });
      expect(report.verification).toMatchObject({
        status: "matches",
        crc32: {
          status: "match",
          expected_hex: "5f6d3801",
          observed_hex: "5f6d3801",
        },
        build_id: {
          status: "unavailable",
          reason: "candidate_build_id_unknown",
        },
      });
      expect(report.limitations).toEqual(
        expect.arrayContaining([
          ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
          ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
        ]),
      );
    } finally {
      await service.close();
    }
  });
});

describe("ELF debug-link candidate degradation", () => {
  it.each([
    ["with", "candidate_elf_malformed"],
    ["without", "binary_build_id_absent"],
  ] as const)(
    "reports a candidate with ELF magic and a bad header as malformed for an image %s a build-id",
    async (presence, reason) => {
      const root = await createTestTempDirectory(
        "rea-elf-debug-link-malformed-",
      );
      // ELF magic, ELFCLASS64, little-endian, then an unsupported EI_VERSION.
      const candidate = Buffer.alloc(64);
      candidate.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 9]);
      const image = elfDebugLinkFixture({
        ...(presence === "with" ? {} : { notes: null }),
        debuglink: debuglinkSection(
          FIXTURE_DEBUG_NAME,
          zlib.crc32(candidate),
          true,
        ),
      });
      const path = join(root, "prog");
      const candidatePath = join(root, FIXTURE_DEBUG_NAME);
      await writeFile(path, image);
      await writeFile(candidatePath, candidate);
      const service = createElfDebugLinkService();
      try {
        const result = await service.inspect({
          path,
          candidate_path: candidatePath,
        });
        if (!result.ok) throw result.error;
        const report = elfDebugLinkSchema.parse(result.value.normalized_result);
        expect(report.candidate).toMatchObject({
          format: null,
          byte_order: null,
          debug_info: "unknown",
          symtab: "unknown",
        });
        expect(report.verification).toMatchObject({
          status: "matches",
          crc32: { status: "match" },
          build_id: { status: "unavailable", reason },
        });
      } finally {
        await service.close();
      }
    },
  );

  it("degrades a candidate over the note entry budget without losing the image", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-entries-");
    const candidate = elfDebugLinkFixture({
      debuglink: null,
      debugInfo: Buffer.from("debug-info", "latin1"),
      notes: Buffer.concat([
        gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
        gnuBuildIdNote("bb".repeat(20), true),
      ]),
    });
    const image = elfDebugLinkFixture({
      debuglink: debuglinkSection(
        FIXTURE_DEBUG_NAME,
        zlib.crc32(candidate),
        true,
      ),
    });
    const path = join(root, "prog");
    const candidatePath = join(root, FIXTURE_DEBUG_NAME);
    await writeFile(path, image);
    await writeFile(candidatePath, candidate);
    const service = createElfDebugLinkService();
    try {
      const result = await service.inspect({
        path,
        candidate_path: candidatePath,
        max_entries: 1,
      });
      if (!result.ok) throw result.error;
      const report = elfDebugLinkSchema.parse(result.value.normalized_result);
      expect(report.build_id).toMatchObject({
        status: "observed",
        hex: FIXTURE_BUILD_ID_HEX,
      });
      expect(report.debuglink.status).toBe("present");
      expect(report.candidate).toMatchObject({
        format: "elf64",
        debug_info: "present",
        symtab: "absent",
      });
      expect(report.verification).toMatchObject({
        status: "matches",
        crc32: { status: "match" },
        build_id: {
          status: "unavailable",
          binary_hex: FIXTURE_BUILD_ID_HEX,
          candidate_hex: null,
          reason: "candidate_build_id_unknown",
        },
      });
      expect(report.limitations).toEqual(
        expect.arrayContaining([
          ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
          ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
        ]),
      );
    } finally {
      await service.close();
    }
  });
});
