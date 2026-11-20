import { ParseFailureError } from "../domain/parseFailure.js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SaxesParser } from "saxes";
import { DOMParser } from "@xmldom/xmldom";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  mavenGradleMetadataSchema,
  type MavenGradleMetadata,
} from "../domain/java/mavenGradleMetadata.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
} from "./MavenGradleMetadata.fixture.js";
import { MavenGradleMetadataProvider } from "./MavenGradleMetadataProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
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

it("keeps a missing child artifact separate from inheritable parent coordinates", () => {
  const report = parse(
    `<project><modelVersion>4.0.0</modelVersion><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent></project>`,
  );
  expect(report.coordinates).toEqual({
    group_id: null,
    artifact_id: null,
    version: null,
    packaging: null,
  });
  expect(report.unresolved).toEqual([
    {
      kind: "parent-coordinate",
      reference: "parent.group_id",
      field: "group_id",
      owner: "project",
      index: null,
    },
    {
      kind: "missing-coordinate",
      reference: "project.artifact_id",
      field: "artifact_id",
      owner: "project",
      index: null,
    },
    {
      kind: "parent-coordinate",
      reference: "parent.version",
      field: "version",
      owner: "project",
      index: null,
    },
  ]);
});

it("preserves an opaque XML counting failure without allocating a DOM", () => {
  const cause = new Error("controlled XML counter failure");
  const syntax = vi
    .spyOn(SaxesParser.prototype, "write")
    .mockImplementationOnce(() => {
      throw cause;
    });
  const dom = vi.spyOn(DOMParser.prototype, "parseFromString");
  try {
    let failure: unknown;
    try {
      parse(mavenPomFixture);
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBe(cause);
    expect(dom).not.toHaveBeenCalled();
  } finally {
    syntax.mockRestore();
    dom.mockRestore();
  }
});

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
  ).toThrow(ParseFailureError);
  try {
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/selected",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (cause instanceof ParseFailureError)
      expect(cause.failure.kind).toBe(kind);
  }
};

it("classifies a Maven qualifier with parentheses as a literal version", () => {
  const report = parse(`
    <project><modelVersion>4.0.0</modelVersion>
      <groupId>example</groupId><artifactId>consumer</artifactId><version>1</version>
      <dependencies>
        <dependency><groupId>example</groupId><artifactId>literal</artifactId><version>1.0-release(build)</version></dependency>
        <dependency><groupId>example</groupId><artifactId>range</artifactId><version>(,2.0]</version></dependency>
      </dependencies>
    </project>
  `);
  expect(
    report.dependencies.map(({ version, version_kind }) => [
      version,
      version_kind,
    ]),
  ).toEqual([
    ["1.0-release(build)", "literal"],
    ["(,2.0]", "range"],
  ]);
});

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
    { name: "revision", value: "1.2.3", value_credentials_redacted: false },
    {
      name: "jackson.version",
      value: "2.17.2",
      value_credentials_redacted: false,
    },
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
  expect(report.coordinates.version).toBe("${revision}${sha1}${changelist}");
  expect(
    report.unresolved.filter(
      (entry) => entry.owner === "project" && entry.field === "version",
    ),
  ).toEqual(
    ["${revision}", "${sha1}", "${changelist}"].map((reference) => ({
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

it("removes credentials from POM property values", () => {
  const report = parse(`<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>demo</artifactId>
  <properties>
    <repo.url>https://user:password@repo.example/maven</repo.url>
    <mirror.url>https://repo.example/mirror</mirror.url>
    <owner>user@example.com</owner>
  </properties>
</project>`);
  expect(report.properties).toEqual([
    {
      name: "repo.url",
      value: "https://repo.example/maven",
      value_credentials_redacted: true,
    },
    {
      name: "mirror.url",
      value: "https://repo.example/mirror",
      value_credentials_redacted: false,
    },
    {
      name: "owner",
      value: "user@example.com",
      value_credentials_redacted: false,
    },
  ]);
  expect(JSON.stringify(report)).not.toContain("password");
});

it("applies XML end-of-line handling to POM text", () => {
  const report = parse(
    "<project>\r\n  <modelVersion>4.0.0</modelVersion>\r\n  <artifactId>demo</artifactId>\r\n  <properties>\r\n    <banner>first\r\nsecond\rthird</banner>\r\n  </properties>\r\n</project>\r\n",
  );
  expect(report.properties).toEqual([
    {
      name: "banner",
      value: "first\nsecond\nthird",
      value_credentials_redacted: false,
    },
  ]);
});

it.each([
  ["&#xA0;", "\u00a0"],
  ["&#xFEFF;", "\ufeff"],
  ["&#x20;", ""],
])(
  "preserves declared POM version characters at a %s boundary",
  (reference, retained) => {
    const report = parse(`<project>
    <modelVersion>4.0.0</modelVersion>
    <groupId>example</groupId>
    <artifactId>demo</artifactId>
    <version>  ${reference}1.0${reference}  </version>
    <dependencies>
      <dependency>
        <groupId>example</groupId>
        <artifactId>library</artifactId>
        <version>  ${reference}2.0${reference}  </version>
      </dependency>
    </dependencies>
  </project>`);
    expect(report.coordinates.version).toBe(`${retained}1.0${retained}`);
    expect(report.dependencies[0]?.version).toBe(`${retained}2.0${retained}`);
  },
);

it("lists properties in packaging, scope, type and classifier", () => {
  const report = parse(`<project>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <packaging>\${artifact.packaging}</packaging>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>lib</artifactId>
      <version>1.0.0</version>
      <scope>\${lib.scope}</scope>
      <type>\${lib.type}</type>
      <classifier>\${os}-\${arch}</classifier>
    </dependency>
  </dependencies>
</project>`);
  expect(report.unresolved).toEqual([
    {
      kind: "property",
      reference: "${artifact.packaging}",
      field: "packaging",
      owner: "project",
      index: null,
    },
    ...(
      [
        ["scope", "${lib.scope}"],
        ["type", "${lib.type}"],
        ["classifier", "${os}"],
        ["classifier", "${arch}"],
      ] as const
    ).map(([field, reference]) => ({
      kind: "property",
      reference,
      field,
      owner: "dependency",
      index: 0,
    })),
  ]);
});

it.each([
  ["]1.0,2.0]", "range"],
  ["[1.0,2.0[", "range"],
  ["(,2.0]", "range"],
  ["[1.0,)", "range"],
  ["[1.0]", "range"],
  ["[1.0\u00a0beta,2.0]", "range"],
  ["[1.0\u2003beta]", "range"],
  ["[1.0\tbeta,2.0]", "literal"],
  ["[\t1.0,\r\n2.0 ]", "range"],
  ["[\u00a01.0 ,2.0]", "range"],
  ["[1.0 \u00a0,2.0]", "literal"],
  ["1.+", "dynamic"],
  ["latest.release", "dynamic"],
  ["latest.release.candidate", "dynamic"],
  ["sdk[preview]", "literal"],
  ["[1.0,2.0", "literal"],
])("reports Gradle selector %s as %s", (requires, versionKind) => {
  const report = parse(
    JSON.stringify({
      formatVersion: "1.1",
      component: { group: "com.example", module: "demo", version: "1.0.0" },
      variants: [
        {
          name: "apiElements",
          dependencies: [
            { group: "com.example", module: "lib", version: { requires } },
          ],
        },
      ],
    }),
    "/artifacts/demo-1.0.0.module",
  );
  expect(report.dependencies[0]).toMatchObject({
    version: requires,
    version_kind: versionKind,
  });
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
      optional_spelling: "${dep.optional}",
    }),
    expect.objectContaining({
      artifact_id: "omitted",
      optional: null,
      optional_spelling: null,
    }),
  ]);
  expect(report.unresolved).toContainEqual({
    kind: "property",
    reference: "${dep.optional}",
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

it("refuses a POM with two top-level dependencies blocks", () => {
  expectFailure(
    `<project>
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>first</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>second</artifactId>
      <version>2.0.0</version>
    </dependency>
  </dependencies>
</project>`,
    "malformed",
  );
});

it("refuses a POM with two dependencies blocks inside dependencyManagement", () => {
  expectFailure(
    `<project>
  <artifactId>demo</artifactId>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>first</artifactId>
        <version>1.0.0</version>
      </dependency>
    </dependencies>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>second</artifactId>
        <version>2.0.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`,
    "malformed",
  );
});

it("refuses a POM dependency with two version children", () => {
  expectFailure(
    `<project>
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>lib</artifactId>
      <version>1.0.0</version>
      <version>2.0.0</version>
    </dependency>
  </dependencies>
</project>`,
    "malformed",
  );
});

it("refuses malformed Gradle JSON", () => {
  expectFailure("{", "malformed");
});

it("keeps malformed Gradle JSON source out of the failure message", () => {
  const bytes = Buffer.from('{\n "url": //user:secret@repo.example/x}', "utf8");
  let failure: unknown;
  try {
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/demo.module",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ParseFailureError);
  expect(failure).toMatchObject({ failure: { kind: "malformed" } });
  const { message } = failure as ParseFailureError;
  expect(message).not.toContain("user:secret");
  expect(message).not.toContain("repo.example");
  expect(message).not.toContain('"url"');
});

it("refuses unreadable Gradle version and available-at values", () => {
  const module = (variant: Record<string, unknown>) =>
    JSON.stringify({
      formatVersion: "1.1",
      component: { group: "com.example", module: "demo", version: "1.0.0" },
      variants: [{ name: "runtime", ...variant }],
    });
  const dependency = (version: unknown) =>
    module({
      dependencies: [{ group: "com.example", module: "lib", version }],
    });
  expectFailure(dependency(42), "malformed");
  expectFailure(dependency(null), "malformed");
  expectFailure(dependency({ requires: 42 }), "malformed");
  expectFailure(dependency({ strictly: ["1.0"] }), "malformed");
  expectFailure(module({ "available-at": "demo-jvm" }), "malformed");
  expectFailure(module({ "available-at": [] }), "malformed");
});

it("refuses Gradle metadata with a repeated field instead of keeping the last", () => {
  const source = `{"formatVersion":"1.1","component":{"group":"com.example","module":"demo","version":"1.0.0"},"variants":[{"name":"runtime","dependencies":[{"group":"com.example","module":"lib","version":{"requires":"1.0"}}],"dependencies":[]}]}`;
  expectFailure(source, "malformed");
  const root = `{"formatVersion":"1.1","formatVersion":"1.1","component":{"group":"com.example","module":"demo","version":"1.0.0"},"variants":[]}`;
  expectFailure(root, "malformed");
});

it("keeps a repeated Gradle field name out of the failure message", () => {
  const source = `{"formatVersion":"1.1","https://user:secret@repo.example/x":1,"https://user:secret@repo.example/x":2,"component":{"group":"com.example","module":"demo","version":"1.0.0"},"variants":[]}`;
  const bytes = Buffer.from(source, "utf8");
  let failure: unknown;
  try {
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/demo.module",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ParseFailureError);
  expect(failure).toMatchObject({ failure: { kind: "malformed" } });
  const { message } = failure as ParseFailureError;
  expect(message).not.toContain("user:secret");
  expect(message).not.toContain("repo.example");
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

// A 1,000-character variant name on 5,000 dependency rows repeats 5,000,000
// characters, past the fixed allowance, from about 300 KB of input.
const repeatedVariantModule = () =>
  JSON.stringify({
    formatVersion: "1.1",
    component: { group: "com.example", module: "demo", version: "1.0.0" },
    variants: [
      {
        name: "v".repeat(1000),
        dependencies: Array.from({ length: 5000 }, (_, index) => ({
          group: "com.example",
          module: `lib${String(index)}`,
          version: { requires: "1.0" },
        })),
      },
    ],
  });

it("refuses Gradle metadata whose rows would repeat variant names past the report allowance", () => {
  const bytes = Buffer.from(repeatedVariantModule(), "utf8");
  expect(() =>
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/demo.module",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    }),
  ).toThrow(ParseFailureError);
});

it("reports the repeated variant-name refusal as a fixed report allowance", async () => {
  const root = await createTestTempDirectory("rea-gradle-report-");
  const path = join(root, "demo.module");
  await writeFile(path, repeatedVariantModule());
  const provider = new MavenGradleMetadataProvider();
  try {
    const result = await provider.inspect({
      path,
      max_file_bytes: 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      remediation: {
        action: expect.stringContaining("fixed report allowance"),
      },
    });
  } finally {
    await provider.close();
  }
});

it("reads POM values written as CDATA and as mixed text and CDATA", () => {
  const report = parse(`<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId><![CDATA[com.example]]></groupId>
  <artifactId>demo</artifactId>
  <version>1.<![CDATA[2.]]>3</version>
  <properties><revision><![CDATA[1.2.3]]></revision></properties>
</project>`);
  expect(report.coordinates).toMatchObject({
    group_id: "com.example",
    version: "1.2.3",
  });
  expect(report.properties).toContainEqual({
    name: "revision",
    value: "1.2.3",
    value_credentials_redacted: false,
  });
});

it.for([
  `<project name="demo" default="build"><target name="build"/></project>`,
  `<project xmlns="urn:example:other"><artifactId>demo</artifactId></project>`,
])("refuses a non-Maven project document %s as unsupported", (source) => {
  expectFailure(source, "unsupported");
});

const gradleModule = (variant: string) =>
  `{"formatVersion":"1.1","component":{"group":"g","module":"m","version":"1"},"variants":[${variant}]}`;

it.for([
  gradleModule(`{"name":"v","dependencies":{"group":"a"}}`),
  gradleModule(`{"name":"v","dependencyConstraints":"none"}`),
  gradleModule(`{"name":"v","dependencies":[null]}`),
  gradleModule(`null`),
  `{"formatVersion":"1.1","component":{"group":"g","module":"m"},"variants":{}}`,
  gradleModule(
    `{"name":"v","dependencies":[{"group":"a","module":"b","version":{"requires":"1","rejects":"2"}}]}`,
  ),
  gradleModule(
    `{"name":"v","dependencies":[{"group":"a","module":"b","version":{"requires":"1","rejects":[2]}}]}`,
  ),
  gradleModule(
    `{"name":"v","dependencies":[{"group":"a","module":"b","excludes":{"group":"x"}}]}`,
  ),
  gradleModule(
    `{"name":"v","dependencies":[{"group":"a","module":"b","excludes":["x"]}]}`,
  ),
])(
  "refuses Gradle metadata with an unreadable present collection %s",
  (source) => {
    expectFailure(source, "malformed");
  },
);

it("reads Gradle version rejects and dependency exclusions", () => {
  const report = parse(
    gradleModule(
      `{"name":"v","dependencies":[{"group":"a","module":"b","version":{"requires":"1","rejects":["2"]},"excludes":[{"group":"x","module":"y"}]}]}`,
    ),
  );
  expect(report.dependencies).toEqual([
    expect.objectContaining({
      exclusions: [{ group_id: "x", artifact_id: "y" }],
      gradle_version: expect.objectContaining({ rejects: ["2"] }),
    }),
  ]);
});

it.for([
  [
    "Gradle",
    gradleModule(
      `{"name":"v","dependencies":[${Array(65_537).fill("{}").join(",")}]}`,
    ),
  ],
  [
    "POM",
    `<project><artifactId>demo</artifactId><dependencies>${"<dependency/>".repeat(65_537)}</dependencies></project>`,
  ],
] as const)(
  "refuses %s rows past the report allowance before building them",
  ([, source]) => {
    const bytes = Buffer.from(source, "utf8");
    let failure: unknown;
    try {
      parseMavenGradleMetadata(bytes, {
        path: "/artifacts/selected",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure).toMatchObject({
      failure: {
        kind: "limit",
        limit: { name: "dependency_rows", maximum: 65_536, required: 65_537 },
      },
    });
  },
);

it.for([
  [
    "Gradle variants",
    `{"formatVersion":"1.1","variants":[${Array(4_097).fill("{}").join(",")}]}`,
    { allowance: "variants", limit: 4_096, required: 4_097 },
  ],
  [
    "Gradle exclusions",
    gradleModule(
      `{"name":"v","dependencies":[{"group":"a","module":"b","excludes":[${Array(65_537).fill("{}").join(",")}]}]}`,
    ),
    { allowance: "exclusions", limit: 65_536, required: 65_537 },
  ],
  [
    "POM exclusions",
    `<project><artifactId>demo</artifactId><dependencies><dependency><exclusions>${"<exclusion/>".repeat(65_537)}</exclusions></dependency></dependencies></project>`,
    { allowance: "exclusions", limit: 65_536, required: 65_537 },
  ],
] as const)(
  "refuses %s past the report allowance before building them",
  ([, source, expected]) => {
    const bytes = Buffer.from(source, "utf8");
    let failure: unknown;
    try {
      parseMavenGradleMetadata(bytes, {
        path: "/artifacts/selected",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure).toMatchObject({
      failure: {
        kind: "limit",
        limit: {
          name: expected.allowance,
          maximum: expected.limit,
          required: expected.required,
        },
      },
    });
  },
);

it("reports the variant refusal as a fixed report allowance", async () => {
  const root = await createTestTempDirectory("rea-gradle-variants-");
  const path = join(root, "demo.module");
  await writeFile(
    path,
    `{"formatVersion":"1.1","variants":[${Array(4_097).fill("{}").join(",")}]}`,
  );
  const provider = new MavenGradleMetadataProvider();
  try {
    const result = await provider.inspect({
      path,
      max_file_bytes: 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      remediation: {
        action: expect.stringContaining("4096-variant allowance"),
      },
    });
  } finally {
    await provider.close();
  }
});

it("refuses a POM past the XML node allowance before building its tree", () => {
  const source = `<project><artifactId>demo</artifactId><properties>${"<p/>".repeat(1_048_577)}</properties></project>`;
  const bytes = Buffer.from(source, "utf8");
  let failure: unknown;
  try {
    parseMavenGradleMetadata(bytes, {
      path: "/artifacts/selected",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ParseFailureError);
  expect(failure).toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: "xml_nodes", maximum: 1_048_576, required: 1_048_577 },
    },
  });
});

it.each([
  ["gradle-module", gradleModuleFixture, "/artifacts/demo.module"],
  ["maven-pom", mavenPomFixture, "/artifacts/pom.xml"],
] as const)(
  "reads %s with a UTF-8 signature and retains the input identity",
  (format, source, path) => {
    const signed = "\ufeff" + source;
    const report = parse(signed, path);
    const original = parse(source, path);
    expect(report).toEqual({
      ...original,
      artifact: {
        path,
        bytes: Buffer.byteLength(signed),
        sha256: createHash("sha256").update(signed, "utf8").digest("hex"),
      },
      coverage: {
        ...original.coverage,
        examined_bytes: Buffer.byteLength(signed),
      },
    });
    expect(report.format).toBe(format);
  },
);

it("still rejects duplicate fields after a Gradle UTF-8 signature", () => {
  expect(() =>
    parse('\ufeff{"formatVersion":"1.1","formatVersion":"1.1"}'),
  ).toThrow(/declares a field more than once/u);
});
