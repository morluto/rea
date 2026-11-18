import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMavenGradleMetadataService } from "../../../src/composition/mavenGradleMetadata.js";
import { mavenPomFixture } from "../../../src/java/MavenGradleMetadata.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Maven POM and Gradle module metadata stable filesystem boundary", () => {
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
