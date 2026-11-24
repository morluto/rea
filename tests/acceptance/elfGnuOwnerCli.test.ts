import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfNote,
  elfNoteFixture,
  gnuBuildIdNote,
  gnuPropertyNote,
} from "../../src/native/elf/ElfNotes.fixture.js";
import {
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
} from "../../src/native/elf/ElfDebugLink.fixture.js";
import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

cliTest(
  "preserves GNU owner bytes in ELF note inspection through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gnu-owner-notes-");
    const call = await cli.sharedMcpCall!();
    const descriptor = Buffer.from("0123456789abcdef", "hex");
    for (const [label, owner, size, rawOwner] of [
      ["canonical", "GNU", 4, "474e5500"],
      ["unterminated", "GNU", 3, "474e55"],
      ["extra", "GNU\0X", 6, "474e55005800"],
    ] as const) {
      const note = elfNote(owner, 3, descriptor);
      note.writeUInt32LE(size, 0);
      const bytes = elfNoteFixture({ notes: note, ownership: "program" });
      const path = join(root, `${label}.elf`);
      await writeFile(path, bytes);
      const output = await cli.run({
        arguments: ["inspect-elf-notes", path, "--json"],
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const response = await call("inspect_elf_notes", { path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const reports = [output.json, response.structuredContent].map((raw) => {
        const evidence =
          toolContract("inspect_elf_notes").outputSchema.parse(raw);
        expect(fileIdentity(evidence.subject).sha256).toBe(hash(bytes));
        expect(evidence.subject).toMatchObject({ local_path: path });
        const report = evidence.normalized_result;
        expect(report.coverage.status).toBe("complete");
        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]).toMatchObject({
          namesz: size,
          owner: "GNU",
          owner_bytes_hex: rawOwner,
          type_name: label === "canonical" ? "gnu_build_id" : "unknown",
          descriptor: { bytes: descriptor.length, sha256: hash(descriptor) },
          gnu:
            label === "canonical"
              ? { build_id_hex: descriptor.toString("hex") }
              : null,
        });
        return report;
      });
      expect(reports[0]).toEqual(reports[1]);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);

cliTest(
  "requires canonical GNU owner bytes for hardening through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gnu-owner-hardening-");
    const call = await cli.sharedMcpCall!();
    for (const label of ["canonical", "unterminated", "extra"] as const) {
      const canonical = gnuPropertyNote();
      const note =
        label === "extra"
          ? elfNote("GNU\0X", 5, canonical.subarray(16), true, 8)
          : canonical;
      if (label === "unterminated") note.writeUInt32LE(3, 0);
      const bytes = elfNoteFixture({
        notes: note,
        ownership: "program",
        alignment: 8,
      });
      const path = join(root, `${label}.elf`);
      await writeFile(path, bytes);
      const output = await cli.run({
        arguments: ["inspect-binary-hardening", path, "--json"],
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const response = await call("inspect_binary_hardening", { path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const reports = [output.json, response.structuredContent].map((raw) => {
        const evidence = toolContract(
          "inspect_binary_hardening",
        ).outputSchema.parse(raw);
        expect(fileIdentity(evidence.subject).sha256).toBe(hash(bytes));
        expect(evidence.subject).toMatchObject({ local_path: path });
        const report = evidence.normalized_result;
        expect(
          report.images[0]?.rows.find((row) => row.property === "cet_ibt_shstk")
            ?.state,
        ).toBe(label === "canonical" ? "enabled" : "unknown");
        return report;
      });
      expect(reports[0]).toEqual(reports[1]);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);

cliTest(
  "does not use noncanonical GNU owner bytes to verify debug candidates",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gnu-owner-debug-link-");
    const call = await cli.sharedMcpCall!();
    const note = (kind: "canonical" | "unterminated" | "extra") => {
      if (kind === "extra")
        return elfNote("GNU\0X", 3, Buffer.from(FIXTURE_BUILD_ID_HEX, "hex"));
      const bytes = gnuBuildIdNote(FIXTURE_BUILD_ID_HEX);
      if (kind === "unterminated") bytes.writeUInt32LE(3, 0);
      return bytes;
    };
    for (const [binaryKind, candidateKind, reason] of [
      ["canonical", "canonical", null],
      ["unterminated", "canonical", "binary_build_id_absent"],
      ["extra", "canonical", "binary_build_id_absent"],
      ["canonical", "unterminated", "candidate_build_id_absent"],
      ["canonical", "extra", "candidate_build_id_absent"],
    ] as const) {
      const image = elfDebugLinkFixture({
        notes: note(binaryKind),
        debuglink: null,
      });
      const candidate =
        candidateKind === "canonical"
          ? elfDebugCandidateFixture({ buildIdHex: FIXTURE_BUILD_ID_HEX })
          : elfDebugLinkFixture({
              notes: note(candidateKind),
              debuglink: null,
            });
      const path = join(root, `${binaryKind}-${candidateKind}.elf`);
      const candidatePath = join(root, `${binaryKind}-${candidateKind}.debug`);
      await writeFile(path, image);
      await writeFile(candidatePath, candidate);
      const output = await cli.run({
        arguments: [
          "inspect-elf-debug-link",
          path,
          "--candidate-path",
          candidatePath,
          "--json",
        ],
      });
      const response = await call("inspect_elf_debug_link", {
        path,
        candidate_path: candidatePath,
      });
      expect(output.exitCode, output.stderr).toBe(0);
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const reports = [output.json, response.structuredContent].map((raw) => {
        const evidence = toolContract(
          "inspect_elf_debug_link",
        ).outputSchema.parse(raw);
        expect(fileIdentity(evidence.subject).sha256).toBe(hash(image));
        expect(evidence.subject).toMatchObject({ local_path: path });
        expect(evidence.parameters).toMatchObject({
          path,
          candidate_path: candidatePath,
        });
        const report = evidence.normalized_result;
        expect
          .soft(report.build_id.status)
          .toBe(binaryKind === "canonical" ? "observed" : "absent");
        expect
          .soft(report.verification?.status)
          .toBe(reason === null ? "matches" : "cannot_verify");
        expect.soft(report.verification?.build_id).toMatchObject({
          status: reason === null ? "match" : "unavailable",
          reason,
        });
        expect
          .soft(report.lookup_paths.some(({ kind }) => kind === "build_id"))
          .toBe(binaryKind === "canonical");
        return report;
      });
      expect(reports[0]).toEqual(reports[1]);
      expect((await readFile(path)).equals(image)).toBe(true);
      expect((await readFile(candidatePath)).equals(candidate)).toBe(true);
    }
  },
);
