import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
  AnalysisOutputError,
  AnalysisCancelledError,
} from "../../domain/analysisErrorCore.js";
import { ok } from "../../domain/result.js";
import type { MavenGradleMetadata } from "../../domain/java/mavenGradleMetadata.js";
import { parseMavenGradleMetadata } from "../../java/MavenGradleMetadataParser.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
} from "../../java/MavenGradleMetadata.fixture.js";
import { MavenGradleMetadataService } from "./MavenGradleMetadataService.js";

const reportFor = (
  format: MavenGradleMetadata["format"],
): MavenGradleMetadata => {
  const gradle = format === "gradle-module";
  const bytes = Buffer.from(
    gradle ? gradleModuleFixture : mavenPomFixture,
    "utf8",
  );
  return parseMavenGradleMetadata(bytes, {
    path: gradle ? "/artifacts/demo.module" : "/artifacts/pom.xml",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
};

const serviceFor = (report: MavenGradleMetadata) =>
  new MavenGradleMetadataService({
    identity: {
      id: "metadata-fixture",
      name: "Metadata fixture",
      version: "1",
    },
    close: async () => {},
    inspect: async () => ok(report),
  });

const inspect = (report: MavenGradleMetadata, path = report.artifact.path) =>
  serviceFor(report).inspect({ path });

const mavenReport = reportFor("maven-pom");
const gradleReport = reportFor("gradle-module");

it("retains completed Evidence and selected parameters on late cancellation", async () => {
  const report = mavenReport;
  const controller = new AbortController();
  const reason = { source: "metadata completion" };
  const provider = serviceFor(report).provider;
  const service = new MavenGradleMetadataService({
    ...provider,
    inspect: async () => {
      controller.abort(reason);
      return ok(report);
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.partialObservation).toMatchObject({
    operation: "inspect_maven_gradle_metadata",
    parameters: { path: report.artifact.path },
    normalized_result: report,
  });
});

it.for([
  {
    name: "a Maven row attributed to a Gradle variant",
    report: {
      ...mavenReport,
      dependencies: mavenReport.dependencies.map((dependency) => ({
        ...dependency,
        origin: "variant-dependencies",
      })),
    },
  },
  {
    name: "a Gradle report without its format payload",
    report: { ...gradleReport, gradle: null },
  },
  {
    name: "a dependency origin from the wrong Gradle collection",
    report: {
      ...gradleReport,
      dependency_management: gradleReport.dependency_management.map(
        (constraint) => ({ ...constraint, origin: "variant-dependencies" }),
      ),
    },
  },
  {
    name: "complete coverage with the wrong examined byte count",
    report: {
      ...mavenReport,
      coverage: {
        ...mavenReport.coverage,
        examined_bytes: mavenReport.artifact.bytes + 8,
      },
    },
  },
  {
    name: "an artifact identity different from the caller path",
    path: mavenReport.artifact.path,
    report: {
      ...mavenReport,
      artifact: { ...mavenReport.artifact, path: "/other/pom.xml" },
    },
  },
])("rejects $name before forming Evidence", async ({ report, path }) => {
  // Untrusted runtime providers can return values outside the typed port.
  const result = await inspect(report as MavenGradleMetadata, path);
  if (result.ok) throw new Error("Provider output entered Evidence");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
});
