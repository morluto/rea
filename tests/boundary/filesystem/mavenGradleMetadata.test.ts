import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMavenGradleMetadataService } from "../../../src/composition/mavenGradleMetadata.js";
import { mavenPomFixture } from "../../../src/java/MavenGradleMetadata.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Maven POM and Gradle module metadata stable filesystem boundary", () => {
  it("admits a minimal Gradle document by its first decoded member", async () => {
    const root = await createTestTempDirectory("rea-gradle-format-order-");
    const path = join(root, "module.json");
    const service = createMavenGradleMetadataService();
    const inspect = async (source: string) => {
      await writeFile(path, source);
      return service.inspect({ path });
    };
    try {
      // JSON object enumeration promotes numeric keys ahead of string keys.
      const minimal = await inspect(
        String.raw`{"f\u006frmatVersion":"1.1","0":null}`,
      );
      if (!minimal.ok) throw minimal.error;
      expect(minimal.value.normalized_result).toMatchObject({
        format: "gradle-module",
        gradle: { format_version: "1.1", variants: [] },
        dependencies: [],
        coverage: { status: "complete" },
      });
      expect(minimal.value.limitations).not.toContainEqual(
        expect.stringContaining("interpreted using Gradle module metadata 1.1"),
      );
      for (const invalid of [
        '{"variants":[],"formatVersion":"1.1"}',
        '{"formatVersion":"1.1","component":null,"variants":[]}',
        '{"formatVersion":"1.1","createdBy":[]}',
        '{"formatVersion":"1.1","createdBy":{"gradle":false}}',
        '{"formatVersion":"1.1","variants":[{"name":"runtime","attributes":[]}]}',
      ]) {
        const result = await inspect(invalid);
        expect(result).toMatchObject({
          ok: false,
          error: { issues: [{ reason: "invalid_format" }] },
        });
      }
      const unfamiliar = await inspect(
        '{"formatVersion":"2.0","component":{"module":"demo"},"variants":[]}',
      );
      if (!unfamiliar.ok) throw unfamiliar.error;
      expect(unfamiliar.value.normalized_result).toMatchObject({
        coordinates: { artifact_id: "demo" },
        gradle: { format_version: "2.0", variants: [] },
      });
      expect(unfamiliar.value.limitations).toContainEqual(
        expect.stringContaining("interpreted using Gradle module metadata 1.1"),
      );
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-maven-gradle-budget-");
    const path = join(root, "pom.xml");
    await writeFile(path, mavenPomFixture);
    const service = createMavenGradleMetadataService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 16 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
      const control = await service.inspect({ path });
      if (!control.ok) throw control.error;
    } finally {
      await service.close();
    }
  });
});
