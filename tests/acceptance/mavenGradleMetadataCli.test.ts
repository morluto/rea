import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
} from "../../src/java/MavenGradleMetadata.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const outputSchema = toolContract("inspect_maven_gradle_metadata").outputSchema;

cliTest(
  "reports Maven coordinates and a BOM import through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-cli-");
    const path = join(root, "pom.xml");
    const bytes = Buffer.from(mavenPomFixture, "utf8");
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = outputSchema.parse(result.json);
    const report = evidence.normalized_result;
    expect(report.format).toBe("maven-pom");
    expect(report.coordinates.artifact_id).toBe("demo");
    expect(report.coordinates.version).toBe("${revision}");
    expect(report.dependency_management[0]).toMatchObject({
      artifact_id: "spring-boot-dependencies",
      bom_import: true,
    });
    expect(report.coverage.status).toBe("complete");
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  },
);

cliTest(
  "reports Gradle variants and platform constraints through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gradle-cli-");
    const path = join(root, "demo-1.2.3.module");
    await writeFile(path, gradleModuleFixture);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = outputSchema.parse(result.json).normalized_result;
    expect(report.format).toBe("gradle-module");
    expect(report.coordinates).toMatchObject({
      group_id: "com.example",
      artifact_id: "demo",
      version: "1.2.3",
    });
    expect(report.gradle?.variants.map((variant) => variant.name)).toEqual([
      "apiElements",
      "runtimeElements",
      "demoPlatform",
    ]);
    expect(
      report.dependency_management.find((row) => row.platform),
    ).toMatchObject({
      artifact_id: "jackson-databind",
      version: "[2.17,2.18)",
      variant: "demoPlatform",
    });
  },
);

cliTest(
  "resolves a relative POM path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-cli-rel-");
    await writeFile(join(root, "pom.xml"), mavenPomFixture);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", "pom.xml", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      outputSchema.parse(result.json).normalized_result.artifact.path,
    ).toBe(join(root, "pom.xml"));
  },
);

cliTest(
  "fails closed on a file that is not Maven POM or Gradle module metadata",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-cli-foreign-");
    const path = join(root, "notes.txt");
    const foreign = Buffer.from("hello world\n", "utf8");
    await writeFile(path, foreign);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_maven_gradle_metadata",
        partial_observation: {
          kind: "file-snapshot-hash",
          path,
          bytes: foreign.length,
          sha256: createHash("sha256").update(foreign).digest("hex"),
        },
      },
    });
  },
);

cliTest("fails closed on malformed XML", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-maven-cli-malformed-");
  const path = join(root, "pom.xml");
  const corrupt = Buffer.from("<project><artifactId>demo</project>", "utf8");
  await writeFile(path, corrupt);
  const result = await cli.run({
    arguments: ["inspect-maven-gradle-metadata", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "inspect_maven_gradle_metadata",
      partial_observation: {
        kind: "file-snapshot-hash",
        path,
        bytes: corrupt.length,
        sha256: createHash("sha256").update(corrupt).digest("hex"),
      },
    },
  });
});
