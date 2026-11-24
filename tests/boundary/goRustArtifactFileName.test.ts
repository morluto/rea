import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GoBinaryService } from "../../src/application/go/GoBinaryService.js";
import { RustBinaryService } from "../../src/application/rust/RustBinaryService.js";
import { projectAnalysisView } from "../../src/domain/analysisView/analysisView.js";
import { GoBinaryProvider } from "../../src/go/GoBinaryProvider.js";
import { RustBinaryProvider } from "../../src/rust/RustBinaryProvider.js";
import { createGoBinaryFixture } from "../fixtures/go/image.js";
import { createRustImage } from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("records native file names before Evidence serialization and CycloneDX projection", async () => {
  const root = await createTestTempDirectory("rea-metadata-file-name-");
  const go = new GoBinaryService(new GoBinaryProvider());
  const rust = new RustBinaryService(new RustBinaryProvider());
  const names =
    process.platform === "win32"
      ? ["program.exe"]
      : ["backup\\program.exe", "C:\\backup\\program.exe"];
  try {
    for (const file_name of names) {
      const path = join(root, file_name);
      for (const [service, bytes] of [
        [go, createGoBinaryFixture().bytes],
        [rust, createRustImage({ format: "elf" })],
      ] as const) {
        await writeFile(path, bytes);
        const result = await service.inspect({ path });
        if (!result.ok) throw result.error;
        // A later consumer only receives the serialized facts, without access
        // to the source filesystem or its path implementation.
        const evidence = JSON.parse(
          JSON.stringify(result.value),
        ) as typeof result.value;
        expect(evidence.normalized_result).toMatchObject({
          artifact: {
            path,
            file_name,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        });
        const projected = projectAnalysisView(
          {
            evidenceId: evidence.evidence_id,
            operation: evidence.operation,
            predicateType: evidence.predicate_type,
            normalizedResult: evidence.normalized_result,
            subject: evidence.subject,
            limitations: evidence.limitations,
            provider: evidence.provider,
          },
          { kind: "cyclonedx" },
        );
        if (!projected.ok) throw projected.error;
        if (projected.value.kind !== "cyclonedx")
          throw new Error("Expected CycloneDX");
        expect(projected.value.document.metadata.component.name).toBe(
          file_name,
        );
        expect(projected.value.artifact.path).toBe(path);
      }
    }
  } finally {
    await Promise.all([go.close(), rust.close()]);
  }
});

it.skipIf(process.platform !== "win32")(
  "records a mixed-separator Windows input on the fixture drive",
  async () => {
    const root = await createTestTempDirectory("rea-metadata-windows-name-");
    await mkdir(join(root, "backup"));
    const nativePath = join(root, "backup", "program.exe");
    const path = nativePath
      .replaceAll("\\", "/")
      .replace(/\/program\.exe$/u, "\\program.exe");
    const go = new GoBinaryProvider();
    const rust = new RustBinaryProvider();
    try {
      for (const [provider, bytes] of [
        [go, createGoBinaryFixture().bytes],
        [rust, createRustImage({ format: "elf" })],
      ] as const) {
        await writeFile(nativePath, bytes);
        const result = await provider.inspect({ path });
        if (!result.ok) throw result.error;
        expect(result.value.artifact).toMatchObject({
          path,
          file_name: "program.exe",
        });
      }
    } finally {
      await Promise.all([go.close(), rust.close()]);
    }
  },
);
