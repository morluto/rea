import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { GpuCodeObjectsProvider } from "../../../src/gpu/GpuCodeObjectsProvider.js";
import { ModelArtifactProvider } from "../../../src/model/ModelArtifactProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "explains rejected links and suggests only resolved regular-file targets",
  async () => {
    const root = await createTestTempDirectory("rea-rejected-links-");
    const file = join(root, "file.bin");
    const directory = join(root, "directory");
    await writeFile(file, "fixture");
    await mkdir(directory);
    const links = [
      { path: join(root, "file-link"), target: file, kind: "file" },
      {
        path: join(root, "selected-directory"),
        target: directory,
        kind: "directory",
      },
      {
        path: join(root, "selected-missing"),
        target: join(root, "missing"),
        kind: "missing",
      },
    ] as const;
    for (const link of links) await symlink(link.target, link.path);
    const model = new ModelArtifactProvider();
    const gpu = new GpuCodeObjectsProvider();
    onTestFinished(async () => {
      await model.close();
      await gpu.close();
    });
    for (const link of links) {
      const results = [
        await model.inspect({ path: link.path, hash: "header" }),
        await gpu.inspect({ path: link.path, analysis: "inventory" }),
      ];
      for (const result of results) {
        if (result.ok) throw new Error("symbolic link was admitted");
        const projected = projectAnalysisError(result.error);
        expect(projected.details, link.kind).toMatchObject({
          issues: [
            {
              message: expect.stringMatching(/symlink/iu),
            },
          ],
        });
        expect(projected.details, link.kind).toMatchObject({
          issues: [
            {
              message: expect.stringContaining(link.path),
            },
          ],
        });
        if (link.kind === "file")
          expect(projected.remediation.action).toContain(file);
        else expect(projected.remediation.action).not.toContain(link.target);
      }
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a rejected link as invalid input, like the stable-artifact readers",
  async () => {
    const root = await createTestTempDirectory("rea-rejected-link-input-");
    const file = join(root, "file.bin");
    await writeFile(file, "fixture");
    const link = join(root, "file-link");
    await symlink(file, link);
    const loop = join(root, "loop");
    await symlink(loop, loop);
    const model = new ModelArtifactProvider();
    const gpu = new GpuCodeObjectsProvider();
    onTestFinished(async () => {
      await model.close();
      await gpu.close();
    });
    const linked = [
      await model.inspect({ path: link, hash: "header" }),
      await gpu.inspect({ path: link, analysis: "inventory" }),
    ];
    for (const result of linked) {
      if (result.ok) throw new Error("symbolic link was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("invalid_request");
      expect(projected.category).toBe("invalid_input");
      expect(projected.remediation.action).toContain(file);
      expect(projected.details).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["path"],
            reason: "invalid_format",
            message: expect.stringContaining(
              "Expected a regular file without a symlink",
            ),
          }),
        ]),
      });
    }
    const looped = [
      await model.inspect({ path: loop, hash: "header" }),
      await gpu.inspect({ path: loop, analysis: "inventory" }),
    ];
    for (const result of looped) {
      if (result.ok) throw new Error("symbolic link was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("invalid_request");
      expect(projected.category).toBe("invalid_input");
      expect(projected.remediation.action).not.toContain(
        "resolved regular file path",
      );
      expect(projected.message).not.toMatch(/ELOOP/iu);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a traversal loop distinct when the selected leaf cannot be inspected",
  async () => {
    const root = await createTestTempDirectory("rea-loop-links-");
    const loop = join(root, "loop");
    await symlink(loop, loop);
    const path = join(loop, "selected");
    const provider = new ModelArtifactProvider();
    onTestFinished(() => provider.close());
    const result = await provider.inspect({ path, hash: "header" });
    if (result.ok) throw new Error("traversal loop was admitted");
    const projected = projectAnalysisError(result.error);
    expect(projected.message).toContain("ELOOP");
    expect(projected.remediation.action).not.toContain(
      "resolved regular file path",
    );
  },
);
