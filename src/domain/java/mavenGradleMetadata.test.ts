import { expect, it } from "vitest";
import {
  inspectMavenGradleMetadataInputSchema,
  mavenGradleMetadataSchema,
  mavenPropertyReferences,
  requestedVersionKind,
} from "./mavenGradleMetadata.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const jsonSchema = (schema: {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: "draft-2020-12";
      }) => unknown;
    };
  };
}): Record<string, unknown> =>
  schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;

it("applies the shared absolute local-path policy to the public input", () => {
  expect(
    inspectMavenGradleMetadataInputSchema.safeParse({ path: "pom.xml" })
      .success,
  ).toBe(false);
  expect(
    inspectMavenGradleMetadataInputSchema.safeParse({ path: "" }).success,
  ).toBe(false);
  expect(
    inspectMavenGradleMetadataInputSchema.safeParse({
      path: "/artifacts/pom\0.xml",
    }).success,
  ).toBe(false);
  expect(
    inspectMavenGradleMetadataInputSchema.safeParse({
      path: "/artifacts/pom.xml",
    }).success,
  ).toBe(true);

  const shared = jsonSchema(absoluteLocalPathStringSchema);
  const advertised = jsonSchema(inspectMavenGradleMetadataInputSchema);
  const path = (
    advertised.properties as Record<string, Record<string, unknown>>
  ).path;
  const {
    $schema: _schema,
    description: _sharedDescription,
    ...sharedPolicy
  } = shared;
  const { description: _pathDescription, ...pathPolicy } = path ?? {};
  expect(pathPolicy).toEqual(sharedPolicy);
  expect(path?.description).toBe(
    "Absolute filesystem path to a Maven pom.xml or Gradle .module metadata file",
  );
});

it("rejects extra caller arguments", () => {
  expect(
    inspectMavenGradleMetadataInputSchema.safeParse({
      path: "/artifacts/pom.xml",
      extra: true,
    }).success,
  ).toBe(false);
});

it("classifies requested versions without interpolating properties", () => {
  expect(mavenPropertyReferences("${revision}")).toEqual(["${revision}"]);
  expect(mavenPropertyReferences("${revision}${sha1}${changelist}")).toEqual([
    "${revision}",
    "${sha1}",
    "${changelist}",
  ]);
  expect(mavenPropertyReferences("1.2.3")).toEqual([]);
  expect(requestedVersionKind("${jackson.version}", "maven-pom")).toBe(
    "property",
  );
  expect(requestedVersionKind("[5.10,6.0)", "maven-pom")).toBe("range");
  expect(requestedVersionKind("(,1.0]", "maven-pom")).toBe("range");
  expect(requestedVersionKind("2.17.2", "maven-pom")).toBe("literal");
  expect(requestedVersionKind(null, "maven-pom")).toBe("missing");
  expect(requestedVersionKind("]1.0,2.0]", "gradle-module")).toBe("range");
  expect(requestedVersionKind("[1.0,2.0[", "gradle-module")).toBe("range");
  expect(requestedVersionKind("1.0]", "maven-pom")).toBe("literal");
});

it("admits a complete POM report with unresolved parent and property references", () => {
  const report = mavenGradleMetadataSchema.parse({
    artifact: {
      path: "/artifacts/pom.xml",
      sha256: "a".repeat(64),
      bytes: 16,
    },
    format: "maven-pom",
    coordinates: {
      group_id: null,
      artifact_id: "demo",
      version: "${revision}",
      packaging: "jar",
    },
    parent: {
      group_id: "com.example",
      artifact_id: "demo-parent",
      version: "9.0.0",
      packaging: null,
      relative_path: "../pom.xml",
      relative_path_declared: true,
    },
    properties: [{ name: "revision", value: "1.2.3" }],
    dependencies: [],
    dependency_management: [],
    gradle: null,
    unresolved: [
      {
        kind: "parent-coordinate",
        reference: "parent.group_id",
        field: "group_id",
        owner: "project",
        index: null,
      },
      {
        kind: "property",
        reference: "${revision}",
        field: "version",
        owner: "project",
        index: null,
      },
    ],
    coverage: { status: "complete", examined_bytes: 16 },
    limitations: ["No Maven or Gradle execution was performed."],
  });
  expect(report.coordinates.artifact_id).toBe("demo");
  expect(report.unresolved).toHaveLength(2);
});
