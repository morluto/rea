import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { DesktopApplicationReader } from "../../../src/artifacts/DesktopApplicationReader.js";
import { DesktopApplicationService } from "../../../src/application/artifacts/DesktopApplicationService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { desktopApplicationSchema } from "../../../src/domain/desktopApplication.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { DirectoryArtifactReader } from "../../../src/resources/index.js";

it.each(["before-open", "during-inspection", "during-stream"] as const)(
  "rejects replacement of the admitted physical root %s even when file identity survives",
  async (stage) => {
    const root = await createTestTempDirectory("rea-directory-root-identity-");
    const original = join(root, "original");
    await mkdir(original);
    await writeFile(join(original, "sample.txt"), "original content");
    const reader = new DirectoryArtifactReader(original);
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry === undefined) throw new Error("Expected sample file");
    const replaceRoot = async () => {
      const moved = join(root, "moved");
      await rename(original, moved);
      await symlink(
        moved,
        original,
        process.platform === "win32" ? "junction" : "dir",
      );
    };
    try {
      if (stage === "before-open") {
        await replaceRoot();
        await expect(reader.open(entry)).rejects.toMatchObject({
          reason: "integrity",
        });
      } else if (stage === "during-inspection") {
        await expect(
          reader.inspectFile(entry, async (file) => {
            const bytes = await file.readFile();
            await replaceRoot();
            return bytes;
          }),
        ).rejects.toMatchObject({ reason: "integrity" });
      } else {
        const stream = await reader.open(entry);
        await replaceRoot();
        await expect(
          (async () => {
            for await (const _chunk of stream) {
              /* consume the admitted file */
            }
          })(),
        ).rejects.toMatchObject({ reason: "integrity" });
      }
    } finally {
      await reader.close();
    }
  },
);

it("discards unverified desktop byte facts when the admitted root changes during inspection", async () => {
  const root = await createTestTempDirectory("rea-desktop-root-identity-");
  const original = join(root, "original");
  const moved = join(root, "moved");
  await mkdir(original);
  const library = "GameAssembly.dll";
  await writeFile(
    join(original, library),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  );
  const pathFact = {
    kind: "il2cpp-library-convention",
    offset: null,
    value: library,
  };
  const baseline = new DesktopApplicationService(
    new DesktopApplicationReader(),
  );
  try {
    const inspected = await baseline.inspect({ path: original });
    if (!inspected.ok) throw inspected.error;
    const report = desktopApplicationSchema.parse(
      inspected.value.normalized_result,
    );
    expect(report.files).toMatchObject([
      {
        path: library,
        ranges: [{ offset: 0, bytes: 4 }],
        facts: [
          pathFact,
          { kind: "native-image-header", offset: 0, value: { format: "elf" } },
        ],
      },
    ]);
  } finally {
    await baseline.close();
  }
  const service = new DesktopApplicationService(
    new DesktopApplicationReader((path) => {
      const reader = new DirectoryArtifactReader(path);
      const inspect = reader.inspectFile.bind(reader);
      reader.inspectFile = (entry, read, signal) =>
        inspect(
          entry,
          async (file) => {
            const value = await read(file);
            await rename(original, moved);
            await symlink(
              moved,
              original,
              process.platform === "win32" ? "junction" : "dir",
            );
            return value;
          },
          signal,
        );
      return reader;
    }),
  );
  try {
    const result = await service.inspect({ path: original });
    if (result.ok) throw new Error("Expected root identity failure");
    const report = desktopApplicationSchema.parse(
      parseEvidence(result.error.partialObservation).normalized_result,
    );
    expect(report.root.path).toBe(original);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]).toMatchObject({
      path: library,
      read_status: "unavailable",
      ranges: [],
      facts: [pathFact],
    });
    expect(report.coverage.status).toBe("partial");
  } finally {
    await service.close();
  }
});
