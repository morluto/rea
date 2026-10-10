import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPeResourcesService } from "../../../src/composition/binaryDiagnostics.js";
import { peResourceFixture } from "../../../src/native/pe/PeResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("PE resource stable filesystem boundary", () => {
  it("rejects symlinks, missing files and directories without inventing empty inventory", async () => {
    const root = await createTestTempDirectory("rea-pe-resource-files-");
    const path = join(root, "image.exe");
    const alias = join(root, "alias.exe");
    await writeFile(path, peResourceFixture().bytes);
    await symlink(path, alias);
    const service = createPeResourcesService();
    for (const candidate of [root, alias, join(root, "missing.exe")]) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error._tag).toBe("ArtifactOperationError");
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-pe-resource-budget-");
    const path = join(root, "image.exe");
    await writeFile(path, peResourceFixture().bytes);
    const service = createPeResourcesService();
    for (const input of [
      { path, max_file_bytes: 64 },
      { path, max_entries: 1 },
    ]) {
      const result = await service.inspect(input);
      if (result.ok) throw new Error("Expected resource budget failure");
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    }
    const result = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});
