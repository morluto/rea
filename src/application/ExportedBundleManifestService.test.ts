import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseExportedBundleManifest,
  serializeExportedBundleManifest,
} from "../domain/exportedBundleManifest.js";
import {
  generateExportedBundleDirectoryManifest,
  verifyExportedBundleDirectory,
} from "./ExportedBundleManifestService.js";

describe("ExportedBundleManifestService directory manifest generation and verification (#6337)", () => {
  it("generates and verifies a bundle directory on disk without executing artifacts, following symlinks, or polluting Object.prototype", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rea-bundle-manifest-6337-"));
    try {
      const scriptsDir = join(tempDir, "scripts");
      await mkdir(scriptsDir, { recursive: true });

      const markerPath = join(tempDir, "executed-marker.txt");
      const executableScript = `#!/bin/sh\necho "pwned" > "${markerPath}"\n`;
      const scriptPath = join(scriptsDir, "payload.sh");
      await writeFile(scriptPath, executableScript, "utf8");
      await chmod(scriptPath, 0o755);

      const metadataPath = join(tempDir, "index.json");
      await writeFile(metadataPath, '{"ok":true}\n', "utf8");

      // Also include a file named "toString" to test Object.prototype safety on roleByRelativePath
      const protoFilePath = join(tempDir, "toString");
      await writeFile(protoFilePath, "proto-safe\n", "utf8");

      const manifest = await generateExportedBundleDirectoryManifest(tempDir, {
        bundle_kind: "web-script-export",
        writeManifestFile: true,
        roleByRelativePath: {
          "index.json": "index",
          "scripts/payload.sh": "script",
        },
      });

      expect(manifest.entries.map((entry) => entry.relative_path)).toEqual([
        "index.json",
        "scripts/payload.sh",
        "toString",
      ]);
      const toStringEntry = manifest.entries.find(
        (entry) => entry.relative_path === "toString",
      );
      expect(toStringEntry?.role).toBeNull();

      const verifiedReport = await verifyExportedBundleDirectory(tempDir);
      expect(verifiedReport.verified).toBe(true);
      expect(verifiedReport.status).toBe("verified");
      expect(verifiedReport.summary.verified_files).toBe(3);
      expect(existsSync(markerPath)).toBe(false);

      // Introduce an empty subdirectory; verification must report it as a non_regular_entry
      const emptySubdir = join(tempDir, "unexpected-empty-dir");
      await mkdir(emptySubdir);
      const emptyDirReport = await verifyExportedBundleDirectory(tempDir);
      expect(emptyDirReport.verified).toBe(false);
      expect(emptyDirReport.findings).toEqual([
        expect.objectContaining({
          kind: "non_regular_entry",
          relative_path: "unexpected-empty-dir",
        }),
      ]);
      await rm(emptySubdir, { recursive: true, force: true });

      // Introduce a symlink in the bundle directory; verification must reject it without following.
      const symlinkPath = join(tempDir, "escaped-link.txt");
      await symlink("/etc/hosts", symlinkPath);

      const symlinkReport = await verifyExportedBundleDirectory(tempDir);
      expect(symlinkReport.verified).toBe(false);
      expect(symlinkReport.status).toBe("failed");
      expect(symlinkReport.findings).toEqual([
        expect.objectContaining({
          kind: "non_regular_entry",
          relative_path: "escaped-link.txt",
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("ExportedBundleManifestService ingression, reproduction, and TOCTOU coverage (#6337)", () => {
  it("executes multi-dataset ingression -> review -> reproduction and catches symlinked manifest or empty-dir drift", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "rea-bundle-g1-"));
    try {
      await mkdir(join(tempRoot, "bin"), { recursive: true });
      await mkdir(join(tempRoot, "decompiled"), { recursive: true });
      await mkdir(join(tempRoot, "reports"), { recursive: true });

      await writeFile(
        join(tempRoot, "bin/routerd.elf"),
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
      );
      await writeFile(
        join(tempRoot, "decompiled/auth_handler.c"),
        "int auth_verify(void) { return 0; }\n",
        "utf8",
      );
      await writeFile(
        join(tempRoot, "reports/triage-\u{1F680}.sarif.json"),
        '{"version":"2.1.0","runs":[]}\n',
        "utf8",
      );

      const manifestPath = join(tempRoot, "rea-bundle-manifest.json");
      const manifest = await generateExportedBundleDirectoryManifest(tempRoot, {
        bundle_kind: "analysis-bundle",
        writeManifestFile: true,
        provenance: {
          artifact: {
            available: true,
            sha256: "d".repeat(64),
            format: "elf",
            architecture: "x86_64",
          },
          provider: {
            available: true,
            id: "rea-ghidra",
            name: "REA Ghidra",
            version: "6.8.0",
          },
          source_evidence_ids: [`ev_${"1".repeat(64)}`, `ev_${"2".repeat(64)}`],
        },
        roleByRelativePath: {
          "bin/routerd.elf": "subject-binary",
          "decompiled/auth_handler.c": "decompilation",
          "reports/triage-\u{1F680}.sarif.json": "sarif-report",
        },
      });

      // Stage 1 -> Stage 2 -> Stage 3 byte-identical reproduction
      const diskManifestBytes = await readFile(manifestPath, "utf8");
      const reparsed = parseExportedBundleManifest(
        JSON.parse(diskManifestBytes),
      );
      expect(serializeExportedBundleManifest(reparsed)).toBe(diskManifestBytes);

      const cleanVerify = await verifyExportedBundleDirectory(tempRoot);
      expect(cleanVerify.verified).toBe(true);
      expect(cleanVerify.summary.verified_files).toBe(3);

      // Post-export mutation 1: replace a file with an empty directory
      await rm(join(tempRoot, "decompiled/auth_handler.c"));
      await mkdir(join(tempRoot, "decompiled/auth_handler.c"));
      const dirDriftVerify = await verifyExportedBundleDirectory(tempRoot);
      expect(dirDriftVerify.verified).toBe(false);
      expect(dirDriftVerify.findings).toEqual([
        expect.objectContaining({
          kind: "non_regular_entry",
          relative_path: "decompiled/auth_handler.c",
        }),
      ]);

      // Restore file, then replace rea-bundle-manifest.json with a symlink (even when passing in-memory manifest)
      await rm(join(tempRoot, "decompiled/auth_handler.c"), {
        recursive: true,
        force: true,
      });
      await writeFile(
        join(tempRoot, "decompiled/auth_handler.c"),
        "int auth_verify(void) { return 0; }\n",
        "utf8",
      );
      await rm(manifestPath);
      await symlink(join(tempRoot, "bin/routerd.elf"), manifestPath);

      const symlinkManifestVerify = await verifyExportedBundleDirectory(
        tempRoot,
        { manifest },
      );
      expect(symlinkManifestVerify.verified).toBe(false);
      expect(symlinkManifestVerify.findings).toEqual([
        expect.objectContaining({
          kind: "non_regular_entry",
          relative_path: "rea-bundle-manifest.json",
        }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
