import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  mavenGradleMetadataSchema,
  type MavenGradleMetadata,
} from "../domain/java/mavenGradleMetadata.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
} from "./MavenGradleMetadata.fixture.js";
import { MavenGradleMetadataFormatFailure } from "./MavenGradleMetadata.errors.js";
import { parseMavenGradleMetadata } from "./MavenGradleMetadataParser.js";

const parse = (source: string, path = "/artifacts/pom.xml") => {
  const bytes = Buffer.from(source, "utf8");
  const report = parseMavenGradleMetadata(bytes, {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  const validated = mavenGradleMetadataSchema.safeParse(report);
  expect(validated.success, JSON.stringify(validated.error)).toBe(true);
  return report;
};

const expectFailure = (
  source: string | Uint8Array,
  kind: "malformed" | "unsupported",
) => {
  const bytes =
    typeof source === "string" ? Buffer.from(source, "utf8") : source;
  expect(() =>
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/selected",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    }),
  ).toThrow(MavenGradleMetadataFormatFailure);
  try {
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/selected",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (cause) {
    expect(cause).toBeInstanceOf(MavenGradleMetadataFormatFailure);
    if (cause instanceof MavenGradleMetadataFormatFailure)
      expect(cause.kind).toBe(kind);
  }
};

it("reads Maven coordinates, parent, BOM import, exclusions, ranges and unresolved properties", () => {
  const report = parse(mavenPomFixture);
  expect(report.format).toBe("maven-pom");
  expect(report.coordinates).toEqual({
    group_id: null,
    artifact_id: "demo",
    version: "${revision}",
    packaging: "jar",
  });
  expect(report.parent).toEqual({
    group_id: "com.example",
    artifact_id: "demo-parent",
    version: "9.0.0",
    packaging: null,
    relative_path: "../pom.xml",
    relative_path_declared: true,
  });
  expect(report.properties).toEqual([
    { name: "revision", value: "1.2.3" },
    { name: "jackson.version", value: "2.17.2" },
  ]);
  expect(report.dependency_management).toEqual([
    expect.objectContaining({
      group_id: "org.springframework.boot",
      artifact_id: "spring-boot-dependencies",
      version: "3.3.4",
      version_kind: "literal",
      type: "pom",
      scope: "import",
      bom_import: true,
      origin: "dependencyManagement",
    }),
    expect.objectContaining({
      group_id: "com.fasterxml.jackson.core",
      artifact_id: "jackson-databind",
      version: "${jackson.version}",
      version_kind: "property",
      origin: "dependencyManagement",
      bom_import: false,
    }),
  ]);
  expect(report.dependencies).toEqual([
    expect.objectContaining({
      group_id: "com.fasterxml.jackson.core",
      artifact_id: "jackson-databind",
      version: null,
      version_kind: "missing",
      scope: "compile",
      optional: false,
      optional_spelling: "false",
      origin: "dependencies",
      exclusions: [
        {
          group_id: "com.fasterxml.jackson.core",
          artifact_id: "jackson-annotations",
        },
      ],
    }),
    expect.objectContaining({
      group_id: "org.junit.jupiter",
      artifact_id: "junit-jupiter",
      version: "[5.10,6.0)",
      version_kind: "range",
      scope: "test",
    }),
  ]);
  expect(report.unresolved).toEqual(
    expect.arrayContaining([
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
      {
        kind: "property",
        reference: "${jackson.version}",
        field: "version",
        owner: "dependency_management",
        index: 1,
      },
      {
        kind: "missing-coordinate",
        reference: "dependency.version",
        field: "version",
        owner: "dependency",
        index: 0,
      },
    ]),
  );
  expect(report.gradle).toBeNull();
  expect(report.coverage.status).toBe("complete");
  expect(report.limitations.join(" ")).toMatch(
    /without running Maven or Gradle/u,
  );
  expect(report.limitations.join(" ")).toMatch(/parent POM was not read/u);
});

it("reads Gradle component coordinates, variants, exclusions and platform constraints", () => {
  const report = parse(gradleModuleFixture, "/artifacts/demo-1.2.3.module");
  expect(report.format).toBe("gradle-module");
  expect(report.coordinates).toEqual({
    group_id: "com.example",
    artifact_id: "demo",
    version: "1.2.3",
    packaging: null,
  });
  expect(report.parent).toBeNull();
  expect(report.gradle).toEqual({
    format_version: "1.1",
    created_by_gradle: "8.10.2",
    variants: [
      {
        name: "apiElements",
        category: "library",
        usage: "java-api",
        available_at: null,
        dependency_count: 1,
        constraint_count: 0,
      },
      {
        name: "runtimeElements",
        category: "library",
        usage: "java-runtime",
        available_at: null,
        dependency_count: 0,
        constraint_count: 1,
      },
      {
        name: "demoPlatform",
        category: "platform",
        usage: null,
        available_at: null,
        dependency_count: 0,
        constraint_count: 1,
      },
    ],
  });
  expect(report.dependencies).toEqual([
    expect.objectContaining({
      group_id: "com.fasterxml.jackson.core",
      artifact_id: "jackson-databind",
      version: "2.17.2",
      version_kind: "literal",
      origin: "variant-dependencies",
      variant: "apiElements",
      platform: false,
      exclusions: [
        {
          group_id: "com.fasterxml.jackson.core",
          artifact_id: "jackson-annotations",
        },
      ],
      gradle_version: {
        requires: "2.17.2",
        prefers: null,
        strictly: null,
        rejects: [],
      },
    }),
  ]);
  expect(report.dependency_management).toEqual([
    expect.objectContaining({
      group_id: "org.slf4j",
      artifact_id: "slf4j-api",
      version: "2.0.16",
      origin: "variant-constraints",
      variant: "runtimeElements",
      platform: false,
    }),
    expect.objectContaining({
      group_id: "com.fasterxml.jackson.core",
      artifact_id: "jackson-databind",
      version: "[2.17,2.18)",
      version_kind: "range",
      origin: "variant-constraints",
      variant: "demoPlatform",
      platform: true,
      gradle_version: {
        requires: null,
        prefers: null,
        strictly: "[2.17,2.18)",
        rejects: [],
      },
    }),
  ]);
  expect(report.limitations.join(" ")).toMatch(/available-at coordinates/u);
});

it("does not interpolate Maven properties into coordinates", () => {
  const report = parse(mavenPomFixture);
  expect(report.coordinates.version).toBe("${revision}");
  expect(report.coordinates.version).not.toBe("1.2.3");
});

it("lists every property in a compound CI-friendly version", () => {
  const report = parse(`<project>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>\${revision}\${sha1}\${changelist}</version>
</project>`);
  expect(report.coordinates.version).toBe("\${revision}\${sha1}\${changelist}");
  expect(
    report.unresolved.filter(
      (entry) => entry.owner === "project" && entry.field === "version",
    ),
  ).toEqual(
    ["\${revision}", "\${sha1}", "\${changelist}"].map((reference) => ({
      kind: "property",
      reference,
      field: "version",
      owner: "project",
      index: null,
    })),
  );
});

it("removes credentials from Gradle available-at URLs", () => {
  const report = parse(
    JSON.stringify({
      formatVersion: "1.1",
      component: { group: "com.example", module: "demo", version: "1.0.0" },
      variants: [
        {
          name: "secret",
          "available-at": {
            url: "https://user:password@repo.example/demo-jvm/1.0.0/demo-jvm-1.0.0.module",
            group: "com.example",
            module: "demo-jvm",
            version: "1.0.0",
          },
        },
        {
          name: "relative",
          "available-at": {
            url: "../../demo-jvm/1.0.0/demo-jvm-1.0.0.module",
            group: "com.example",
            module: "demo-jvm",
            version: "1.0.0",
          },
        },
      ],
    }),
    "/artifacts/demo-1.0.0.module",
  );
  const urls = report.gradle?.variants.map((variant) => ({
    url: variant.available_at?.url,
    redacted: variant.available_at?.url_credentials_redacted,
  }));
  expect(urls).toEqual([
    {
      url: "https://repo.example/demo-jvm/1.0.0/demo-jvm-1.0.0.module",
      redacted: true,
    },
    { url: "../../demo-jvm/1.0.0/demo-jvm-1.0.0.module", redacted: false },
  ]);
  expect(JSON.stringify(report)).not.toContain("password");
});

it("keeps an empty relativePath and a property-spelled optional distinct from omission", () => {
  const report = parse(`<project>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>demo-parent</artifactId>
    <version>1.0.0</version>
    <relativePath/>
  </parent>
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>declared</artifactId>
      <version>1.0.0</version>
      <optional>\${dep.optional}</optional>
    </dependency>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>omitted</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);
  expect(report.parent).toMatchObject({
    relative_path: null,
    relative_path_declared: true,
  });
  expect(report.dependencies).toEqual([
    expect.objectContaining({
      artifact_id: "declared",
      optional: null,
      optional_spelling: "\${dep.optional}",
    }),
    expect.objectContaining({
      artifact_id: "omitted",
      optional: null,
      optional_spelling: null,
    }),
  ]);
  expect(report.unresolved).toContainEqual({
    kind: "property",
    reference: "\${dep.optional}",
    field: "optional",
    owner: "dependency",
    index: 0,
  });

  const omitted = parse(`<project>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>demo-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>demo</artifactId>
</project>`);
  expect(omitted.parent).toMatchObject({
    relative_path: null,
    relative_path_declared: false,
  });
});

it("records unread profiles without activating them", () => {
  const report = parse(`<?xml version="1.0"?>
<project>
  <artifactId>demo</artifactId>
  <profiles>
    <profile>
      <id>extra</id>
      <dependencies>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>hidden</artifactId>
        </dependency>
      </dependencies>
    </profile>
  </profiles>
</project>
`);
  expect(report.dependencies).toEqual([]);
  expect(report.limitations.join(" ")).toMatch(/profiles are present/u);
});

it("refuses malformed XML as invalid format", () => {
  expectFailure("<project><artifactId>demo</project>", "malformed");
});

it("refuses a document type declaration", () => {
  expectFailure(
    `<!DOCTYPE project><project><artifactId>demo</artifactId></project>`,
    "unsupported",
  );
});

it("refuses XML that is not a Maven project", () => {
  expectFailure(
    "<module><artifactId>demo</artifactId></module>",
    "unsupported",
  );
});

it("refuses malformed Gradle JSON", () => {
  expectFailure("{", "malformed");
});

it("keeps malformed Gradle JSON source out of the failure message", () => {
  const bytes = Buffer.from('{\n "url": //user:secret@repo.example/x}', "utf8");
  let message = "";
  try {
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/demo.module",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (cause) {
    expect(cause).toBeInstanceOf(MavenGradleMetadataFormatFailure);
    message = cause instanceof Error ? cause.message : "";
  }
  expect(message).toBe("Gradle module metadata is not well-formed JSON.");
});

it("refuses JSON that is not Gradle module metadata", () => {
  expectFailure('{"name":"demo"}', "unsupported");
});

it("refuses empty and non-metadata files", () => {
  expectFailure("", "malformed");
  expectFailure("not xml or json", "unsupported");
});

it("keeps coverage examined_bytes equal to the artifact length", () => {
  const report: MavenGradleMetadata = parse(mavenPomFixture);
  expect(report.coverage.examined_bytes).toBe(report.artifact.bytes);
});
