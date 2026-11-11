import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { createElfDebugLinkService } from "../../../src/composition/binaryDiagnostics.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
  elfDebugLinkSchema,
} from "../../../src/domain/native/elfDebugLink.js";
import { gnuDebuglinkCrc32 } from "../../../src/native/elf/ElfDebugLink.js";
import { gnuBuildIdNote } from "../../../src/native/elf/ElfNotes.fixture.js";
import {
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
} from "../../../src/native/elf/ElfDebugLink.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("ELF debug-link stable filesystem boundary", () => {
  it("reports non-file and malformed ELF selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-files-");
    const path = join(root, "prog");
    const alias = join(root, "alias");
    const malformed = join(root, "malformed");
    await writeFile(path, elfDebugLinkFixture());
    await writeFile(malformed, Buffer.from("not an elf"));
    await symlink(path, alias);
    const service = createElfDebugLinkService();
    try {
      for (const [candidate, reason] of [
        [root, "invalid_format"],
        [alias, "invalid_format"],
        [malformed, "invalid_format"],
        [join(root, "missing"), "invalid_value"],
        [join(path, "child"), "invalid_value"],
      ] as const) {
        const result = await service.inspect({ path: candidate });
        if (result.ok) throw new Error("Expected file acquisition failure");
        expect(result.error).toMatchObject({
          _tag: "AnalysisInputError",
          operation: "inspect_elf_debug_link",
          issues: [
            {
              path: ["path"],
              reason,
              message: expect.any(String),
            },
          ],
        });
      }
    } finally {
      await service.close();
    }
  });

  it("keeps the image linkage for a missing candidate and rejects symlinked or relative candidates", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-candidate-");
    const path = join(root, "prog");
    const alias = join(root, "alias.debug");
    await writeFile(path, elfDebugLinkFixture());
    await symlink(path, alias);
    const service = createElfDebugLinkService();
    try {
      const missing = await service.inspect({
        path,
        candidate_path: join(root, "missing.debug"),
      });
      if (!missing.ok) throw missing.error;
      const report = elfDebugLinkSchema.parse(missing.value.normalized_result);
      expect(report.debuglink.status).toBe("present");
      expect(report.build_id.hex).toBe(FIXTURE_BUILD_ID_HEX);
      expect(report.lookup_paths.length).toBeGreaterThan(0);
      expect(report.candidate).toBeNull();
      expect(report.verification).toMatchObject({
        status: "cannot_verify",
        reason: "candidate_unreadable",
        crc32: { status: "unavailable", reason: "candidate_unreadable" },
        build_id: { status: "unavailable", reason: "candidate_unreadable" },
      });
      const linked = await service.inspect({ path, candidate_path: alias });
      const relative = await service.inspect({
        path,
        candidate_path: "prog.debug",
      });
      if (linked.ok)
        throw new Error("Expected a symlinked candidate rejection");
      expect(linked.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [{ path: ["candidate_path"] }],
      });
      if (relative.ok)
        throw new Error("Expected a relative candidate rejection");
      expect(relative.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [{ path: ["candidate_path"], reason: "invalid_format" }],
      });
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
      const tooMany = await service.inspect({ path, max_entries: 1 });
      if (tooMany.ok) throw new Error("Expected entry budget failure");
      if (!(tooMany.error instanceof AnalysisResourceConstraintError))
        throw new Error("Expected entry budget failure");
      expect(tooMany.error.remediationAction).toContain("smaller image");
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

  it("does not open a conventional lookup path when no candidate is selected", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-decoy-");
    const path = join(root, "prog");
    await writeFile(path, elfDebugLinkFixture());
    await mkdir(join(root, ".debug"));
    await mkdir(join(root, ".debug", "prog.debug"));
    const service = createElfDebugLinkService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      const report = elfDebugLinkSchema.parse(result.value.normalized_result);
      expect(report.verification).toBeNull();
      expect(report.candidate).toBeNull();
      expect(report.debuglink.status).toBe("present");
    } finally {
      await service.close();
    }
  });
});

describe("ELF debug-link streamed candidate boundary", () => {
  it("streams a candidate larger than the image read budget", async () => {
    const root = await createTestTempDirectory("rea-elf-debug-link-stream-");
    // Trailing padding keeps the ELF header while exceeding several chunks.
    const candidate = Buffer.concat([
      elfDebugCandidateFixture(),
      Buffer.alloc(200_000, 0x5a),
    ]);
    const image = elfDebugLinkFixture({
      debuglink: debuglinkSection(
        FIXTURE_DEBUG_NAME,
        gnuDebuglinkCrc32(candidate),
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
        max_file_bytes: image.length,
      });
      if (!result.ok) throw result.error;
      const report = elfDebugLinkSchema.parse(result.value.normalized_result);
      expect(candidate.length).toBeGreaterThan(image.length);
      expect(report.candidate).toMatchObject({
        bytes: candidate.length,
        format: "elf64",
        debug_info: "unknown",
        symtab: "unknown",
      });
      expect(report.verification).toMatchObject({
        status: "matches",
        crc32: { status: "match" },
        build_id: {
          status: "unavailable",
          reason: "candidate_build_id_unknown",
        },
      });
      expect(report.limitations).toContain(
        ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
      );
    } finally {
      await service.close();
    }
  });

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
          gnuDebuglinkCrc32(candidate),
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
      notes: Buffer.concat([
        gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
        gnuBuildIdNote("bb".repeat(20), true),
      ]),
    });
    const image = elfDebugLinkFixture({
      debuglink: debuglinkSection(
        FIXTURE_DEBUG_NAME,
        gnuDebuglinkCrc32(candidate),
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
      expect(report.verification).toMatchObject({
        status: "matches",
        crc32: { status: "match" },
        build_id: {
          status: "unavailable",
          reason: "candidate_build_id_unknown",
        },
      });
      expect(report.limitations).toContain(
        ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
      );
    } finally {
      await service.close();
    }
  });
});
