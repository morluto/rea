import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { expect, it } from "vitest";

import { extractArtifact } from "../../../src/application/ArtifactExtraction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("does not claim unmaterialized nested integrity contradictions were extracted", async () => {
  const root = await createTestTempDirectory("rea-nested-integrity-extract-");
  const source = join(root, "source");
  const original = "console.log('ok');\n";
  const changed = "console.log('no');\n";
  await mkdir(source);
  await writeFile(join(source, "main.js"), original);
  const app = join(root, "app");
  await mkdir(app);
  const archive = join(app, "app.asar");
  await createPackage(source, archive);
  const bytes = await readFile(archive);
  const contentOffset = bytes.indexOf(original);
  expect(contentOffset).toBeGreaterThanOrEqual(0);
  bytes.write(changed, contentOffset, "utf8");
  await writeFile(archive, bytes);

  const result = await extractArtifact({
    inputPath: app,
    inputFormat: "directory",
    outputRoot: join(root, "out"),
    integrity: { mode: "record-and-continue" },
  });

  expect(result.artifacts.map(({ relative_path }) => relative_path)).toEqual([
    "app.asar",
  ]);
  expect(result.integrity_contradictions).toEqual([]);
  expect(result.limitations.join("\n")).toContain(
    "were not written as their own files",
  );
  expect(result.limitations.join("\n")).toContain("main.js");
  expect(result.limitations.join("\n")).not.toContain(
    "extracted file(s) contradict",
  );
});
