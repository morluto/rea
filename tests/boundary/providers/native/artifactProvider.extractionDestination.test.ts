import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import {
  CPU,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { withArtifactClient } from "../../../support/artifactClientScope.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(["direct", "symlink"] as const)(
  "refuses a %s output path inside the source without modifying caller files",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-extraction-source-boundary-",
    );
    const source = join(root, "source.app");
    await mkdir(source);
    await writeFile(join(source, "payload.txt"), "caller bytes");
    await writeFile(
      join(source, "Info.plist"),
      '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Main</string></dict></plist>',
    );
    await writeFile(join(source, "Main"), machoImage({ cpu: CPU.arm64 }));
    const target = await parseBinaryTarget(source);
    if (!target.ok) throw target.error;
    let parent = source;
    if (kind === "symlink") {
      parent = join(root, "alias");
      await symlink(
        source,
        parent,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const output = join(parent, "output");
    const result = await withArtifactClient(target.value, (client) =>
      client.execute("extract_artifact", { output_root: output }),
    );
    expect(result).toMatchObject({ ok: false, error: { reason: "path" } });
    expect((await readdir(source)).sort()).toEqual([
      "Info.plist",
      "Main",
      "payload.txt",
    ]);
    expect(await readFile(join(source, "payload.txt"), "utf8")).toBe(
      "caller bytes",
    );
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
