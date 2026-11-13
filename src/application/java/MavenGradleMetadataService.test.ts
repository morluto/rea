import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import type { MavenGradleMetadata } from "../../domain/java/mavenGradleMetadata.js";
import { parseMavenGradleMetadata } from "../../java/MavenGradleMetadataParser.js";
import { mavenPomFixture } from "../../java/MavenGradleMetadata.fixture.js";
import { MavenGradleMetadataService } from "./MavenGradleMetadataService.js";

const reportFor = (): MavenGradleMetadata => {
  const bytes = Buffer.from(mavenPomFixture, "utf8");
  return parseMavenGradleMetadata(bytes, {
    path: "/artifacts/pom.xml",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
};

const inspect = (report: MavenGradleMetadata, path = report.artifact.path) =>
  new MavenGradleMetadataService({
    identity: {
      id: "metadata-fixture",
      name: "Metadata fixture",
      version: "1",
    },
    close: async () => {},
    inspect: async () => ok(report),
  }).inspect({ path });

it("rejects complete coverage claiming the wrong examined byte count", async () => {
  const report = reportFor();
  const result = await inspect({
    ...report,
    coverage: { ...report.coverage, examined_bytes: report.artifact.bytes + 8 },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a report whose artifact identity disagrees with the caller path", async () => {
  const report = reportFor();
  const result = await inspect(
    {
      ...report,
      artifact: { ...report.artifact, path: "/other/pom.xml" },
    },
    report.artifact.path,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains observed coordinates and unresolved property references", async () => {
  const report = reportFor();
  const result = await inspect(report);
  if (!result.ok) throw result.error;
  expect(parseEvidence(result.value).normalized_result).toMatchObject({
    format: "maven-pom",
    coordinates: {
      artifact_id: "demo",
      version: "${revision}",
    },
    coverage: { status: "complete", examined_bytes: report.artifact.bytes },
  });
  expect(result.value.confidence).toBe("observed");
});
