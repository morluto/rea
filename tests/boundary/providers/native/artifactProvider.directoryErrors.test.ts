import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

describe("artifact directory diagnostics", () => {
  it.skipIf(process.platform === "win32")(
    "preserves the inaccessible member path and errno through provider projection",
    async () => {
      const root = await createTestTempDirectory("rea-directory-eacces-");
      const appPath = join(root, "Denied.app");
      const contentsPath = join(appPath, "Contents");
      const executablePath = join(contentsPath, "MacOS", "Fixture");
      const blockedPath = join(contentsPath, "blocked.txt");
      await mkdir(join(contentsPath, "MacOS"), { recursive: true });
      await writeFile(
        join(contentsPath, "Info.plist"),
        "<plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>",
      );
      const machHeader = Buffer.alloc(8);
      machHeader.writeUInt32BE(0xfeedfacf, 0);
      machHeader.writeUInt32BE(0x0100000c, 4);
      await writeFile(executablePath, machHeader);
      await writeFile(blockedPath, "member contents");
      await chmod(blockedPath, 0);
      try {
        const target = await parseBinaryTarget(appPath);
        expect(target.ok).toBe(true);
        if (!target.ok) return;
        const result = await new ArtifactProvider()
          .createClient(target.value)
          .execute("inventory_artifact", {});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "artifact_operation_failed",
          details: {
            operation: "inventory_artifact",
            reason: "io",
          },
        });
        const projected = projectAnalysisError(result.error);
        const detail = projected.details?.detail;
        expect(typeof detail).toBe("string");
        expect(detail).toContain("Denied.app/Contents/blocked.txt");
        expect(detail).toContain("EACCES");
      } finally {
        await chmod(blockedPath, 0o600);
      }
    },
  );
});
