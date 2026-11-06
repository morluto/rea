import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { mavenPomSchema } from "../../domain/mavenPom/mavenPom.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectMavenPomEvidence } from "./MavenPomService.js";

const pomBytes = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>service</artifactId>
  <version>1.2.3</version>
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.13</version>
    </dependency>
  </dependencies>
</project>
`;

const writePom = async (bytes: Uint8Array | string) => {
  const root = await createTestTempDirectory("rea-maven-pom-");
  const path = join(root, "pom.xml");
  await writeFile(path, bytes);
  return path;
};

it("binds the selected bytes to retained declarations", async () => {
  const path = await writePom(pomBytes);
  const resources = new ArtifactResourceScope();
  const result = await inspectMavenPomEvidence({ path }, resources);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;

  const value = mavenPomSchema.parse(result.value.evidence.normalized_result);
  expect(value.artifact).toEqual({
    path,
    bytes: Buffer.byteLength(pomBytes),
    sha256: createHash("sha256").update(pomBytes).digest("hex"),
  });
  expect(value.dependencies.map((d) => d.artifact_id)).toEqual(["slf4j-api"]);
  expect(result.value.evidence.operation).toBe("inspect_maven_pom");
  // Selection fields never change the published result or its identity.
  expect(result.value.evidence.parameters).toMatchObject({ path });
  expect(result.value.observation.sha256).toBe(value.artifact.sha256);
});

it("refuses a document type declaration without reading anything it names", async () => {
  const path = await writePom(
    `<?xml version="1.0"?>
<!DOCTYPE project [<!ENTITY leak SYSTEM "file:///etc/passwd">]>
<project><modelVersion>4.0.0</modelVersion>&leak;</project>`,
  );
  const result = await inspectMavenPomEvidence(
    { path },
    new ArtifactResourceScope(),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a refused POM");
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect((result.error as AnalysisInputError).issues).toEqual([
    expect.objectContaining({
      path: ["path"],
      reason: "invalid_format",
      message: expect.stringContaining(
        "document types are unsupported",
      ) as string,
    }),
  ]);
});

it("refuses well-formed XML whose root is not a Maven project", async () => {
  const path = await writePom(
    "<settings><localRepository>/tmp/repo</localRepository></settings>",
  );
  const result = await inspectMavenPomEvidence(
    { path },
    new ArtifactResourceScope(),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a refused POM");
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect((result.error as AnalysisInputError).issues).toEqual([
    expect.objectContaining({
      path: ["path"],
      reason: "invalid_format",
      message: expect.stringContaining("not a Maven POM") as string,
    }),
  ]);
});

it("retains the verified file identity when parsing fails", async () => {
  const bytes = "<project><dependencies></project>";
  const path = await writePom(bytes);
  const result = await inspectMavenPomEvidence(
    { path },
    new ArtifactResourceScope(),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a refused POM");
  expect(result.error.partialObservation).toMatchObject({
    kind: "file-snapshot-hash",
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
});
