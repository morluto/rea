import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveArtifactPathByContext } from "../../../src/application/JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "../../../src/application/JavaScriptArtifactFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
const execute = promisify(execFile);
describe("ordered package exports conditions", () => {
  it.each(["import", "require"] as const)(
    "matches Node when default precedes %s",
    async (moduleKind) => {
      const root = await createTestTempDirectory("rea-exports-order-");
      const packageDirectory = join(root, "node_modules", "example");
      await mkdir(packageDirectory, { recursive: true });
      const metadata = JSON.stringify({
        exports: { default: "./default.cjs", [moduleKind]: "./specific.cjs" },
      });
      await writeFile(join(packageDirectory, "package.json"), metadata);
      await writeFile(
        join(packageDirectory, "default.cjs"),
        'module.exports = "default";',
      );
      await writeFile(
        join(packageDirectory, "specific.cjs"),
        'module.exports = "specific";',
      );
      const { stdout } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          moduleKind === "import"
            ? 'console.log((await import("example")).default)'
            : 'import { createRequire } from "node:module"; console.log(createRequire(import.meta.url)("example"))',
        ],
        { cwd: root },
      );
      expect(stdout.trim()).toBe("default");
      const contents = new Map([
        ["main.js", ""],
        ["node_modules/example/package.json", metadata],
        ["node_modules/example/default.cjs", ""],
        ["node_modules/example/specific.cjs", ""],
      ]);
      const files = new Map<string, JavaScriptArtifactFile>(
        [...contents].map(([path, value]) => [
          path,
          {
            path,
            container_sha256: "a".repeat(64),
            sha256: "b".repeat(64),
            bytes: Buffer.byteLength(value),
            inventory_artifact_id: path,
            kind: path.endsWith("package.json") ? "package-json" : "javascript",
            unpacked: false,
            text: { included: true, value },
          },
        ]),
      );
      expect(
        resolveArtifactPathByContext({
          declaredPath: "example",
          sourcePath: "main.js",
          context: "module-specifier",
          moduleKind,
          files,
        }),
      ).toMatchObject({
        resolution_status: "resolved",
        resolved_path: "node_modules/example/default.cjs",
      });
    },
  );
});
