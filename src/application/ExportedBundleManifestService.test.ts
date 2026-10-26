import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
