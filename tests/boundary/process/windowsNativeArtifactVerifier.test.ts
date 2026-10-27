import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

for (const mode of ["preinstall source", "packed source-free"]) {
  processTest(
    `verifies native artifact identity from ${mode} without installed dependencies`,
    async ({ processes }) => {
      const root = await createTestTempDirectory(
        "rea-native-artifact-verifier-",
      );
      const paths =
        mode === "preinstall source"
          ? [
              "scripts/lib/verifier-source-loader.mjs",
              "src/domain/windowsNativeArtifact.ts",
              "src/domain/peCoffHeader.ts",
              "src/domain/dosMz.ts",
              "src/domain/result.ts",
            ]
          : [
              "dist/domain/windowsNativeArtifact.js",
              "dist/domain/peCoffHeader.js",
              "dist/domain/dosMz.js",
              "dist/domain/result.js",
            ];
      for (const path of [
        "scripts/verify-windows-native-artifact.mjs",
        ...paths,
      ]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await copyFile(join(repository, path), join(root, path));
      }
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module", version: "1.0.0" }),
      );
      const artifactRoot = join(root, "native/windows/build");
      await mkdir(artifactRoot, { recursive: true });
      // An inert PE header establishes artifact validation, never addon loading.
      const bytes = Buffer.alloc(128);
      bytes.write("MZ");
      bytes.writeUInt32LE(64, 0x3c);
      bytes.write("PE\0\0", 64, "ascii");
      bytes.writeUInt16LE(0x8664, 68);
      bytes.writeUInt16LE(0x20b, 88);
      const manifest = {
        packageVersion: "1.0.0",
        platform: "win32",
        architecture: "x64",
        abiVersion: 1,
        nodeApiVersion: 8,
        artifact: "rea-windows-x64.node",
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      };
      await writeFile(join(artifactRoot, manifest.artifact), bytes);
      const manifestPath = join(artifactRoot, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const run = () =>
        processes.run(
          process.execPath,
          [join(root, "scripts/verify-windows-native-artifact.mjs")],
          { cwd: root, timeoutMs: 10_000 },
        );
      const valid = await run();
      expect(valid.exitCode, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toEqual({
        ok: true,
        ...manifest,
        artifactBytes: bytes.length,
      });
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, extra: true }),
      );
      const invalid = await run();
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("missing or unknown fields");
    },
  );
}
