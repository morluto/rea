import { describe, expect, it } from "vitest";
import { mavenPomSchema, type MavenPomArtifact } from "./mavenPom.js";
import { parseMavenPom } from "./parseMavenPom.js";
import { parseXmlDocument } from "../xmlDocument.js";

const artifact: MavenPomArtifact = {
  path: "/fixtures/pom.xml",
  sha256: "a".repeat(64),
  bytes: 1,
};

const parse = (source: string) => {
  const document = parseXmlDocument(source, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  if (!document.ok) throw document.error;
  const result = parseMavenPom(document.value, artifact);
  // The parser's contract is the advertised schema, not just its return type.
  return mavenPomSchema.parse(result);
};

const pom = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>service</artifactId>
  <version>1.2.3</version>
  ${body}
</project>`;

describe("project model", () => {
  it("reads the project coordinate, packaging and parent without resolving them", () => {
    const result = parse(
      pom(`
  <packaging>war</packaging>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>platform</artifactId>
    <version>9.0.0</version>
    <relativePath>../platform/pom.xml</relativePath>
  </parent>`),
    );
    expect(result.model_version).toBe("4.0.0");
    expect(result.project).toEqual({
      group_id: "com.example",
      artifact_id: "service",
      version: "1.2.3",
      packaging: "war",
    });
    expect(result.parent).toEqual({
      group_id: "com.example",
      artifact_id: "platform",
      version: "9.0.0",
      packaging: null,
      relative_path: "../platform/pom.xml",
    });
    expect(result.source_coverage.parent_pom).toBe("not-read");
    expect(result.pom_id).toMatch(/^maven_pom_[a-f0-9]{64}$/u);
  });
});

describe("dependencies", () => {
  it("assigns positions per element name across a large sibling list", () => {
    const declarations = Array.from({ length: 1000 }, (_, index) =>
      `<other/><dependency><groupId>example</groupId><artifactId>item-${String(index)}</artifactId></dependency>`,
    ).join("");
    const result = parse(pom(`<dependencies>${declarations}</dependencies>`));
    expect(result.dependencies).toHaveLength(1000);
    expect(result.dependencies.map(({ source_pointer }) => source_pointer)).toEqual(
      Array.from({ length: 1000 }, (_, index) =>
        `/dependencies[0]/dependency[${String(index)}]`,
      ),
    );
  });
  it("keeps a declared version distinct from a managed one", () => {
    const result = parse(
      pom(`
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.slf4j</groupId>
        <artifactId>slf4j-api</artifactId>
        <version>2.0.13</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.2.1-jre</version>
    </dependency>
    <dependency>
      <groupId>org.unmanaged</groupId>
      <artifactId>thing</artifactId>
    </dependency>
  </dependencies>`),
    );
    expect(result.dependency_management).toHaveLength(1);
    expect(result.dependency_management[0]?.declared_by).toBe(
      "dependency_management",
    );
    expect(
      result.dependencies.map((d) => [d.artifact_id, d.version_origin]),
    ).toEqual([
      ["slf4j-api", { kind: "managed", managed_by: "dependencyManagement" }],
      ["guava", { kind: "declared" }],
      ["thing", { kind: "unresolved" }],
    ]);
    expect(result.summary.unresolved_versions).toBe(1);
  });

  it("retains exclusions, optionality, scope and classifier as declarations", () => {
    const result = parse(
      pom(`
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>driver</artifactId>
      <version>1.0</version>
      <scope>test</scope>
      <optional>true</optional>
      <type>jar</type>
      <classifier>tests</classifier>
      <exclusions>
        <exclusion>
          <groupId>log4j</groupId>
          <artifactId>log4j</artifactId>
        </exclusion>
      </exclusions>
    </dependency>
  </dependencies>`),
    );
    const dependency = result.dependencies[0];
    expect(dependency).toMatchObject({
      group_id: "org.example",
      artifact_id: "driver",
      scope: "test",
      optional: true,
      type: "jar",
      classifier: "tests",
      exclusions: [{ group_id: "log4j", artifact_id: "log4j" }],
    });
    expect(result.summary.optional_dependencies).toBe(1);
    expect(result.summary.excluded_dependencies).toBe(1);
    expect(dependency?.line).toBeGreaterThan(0);
    expect(dependency?.source_pointer).toContain("dependency[0]");
  });
});

describe("properties and profiles", () => {
  it("keeps property references explicit instead of interpolating Maven fields", () => {
    const result = parse(
      pom(`
  <properties>
    <guava.version>33.2.1-jre</guava.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>\${guava.version}</version>
    </dependency>
    <dependency>
      <groupId>com.missing</groupId>
      <artifactId>absent</artifactId>
      <version>\${project.version}</version>
    </dependency>
  </dependencies>`),
    );
    expect(result.properties).toEqual([
      {
        name: "guava.version",
        value: "33.2.1-jre",
        source_pointer: "/properties[0]/guava.version[0]",
      },
    ]);
    expect(
      result.dependencies.map((d) => [d.artifact_id, d.version_origin.kind]),
    ).toEqual([
      ["guava", "property"],
      ["absent", "property"],
    ]);
    const references = Object.fromEntries(
      result.property_references.map((r) => [r.name, r]),
    );
    expect(references["guava.version"]).toMatchObject({
      declared: "33.2.1-jre",
      resolved: "33.2.1-jre",
    });
    expect(references["project.version"]).toEqual({
      name: "project.version",
      declared: null,
      resolution: "unresolved",
      resolved: null,
      source_pointer: "/project",
    });
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "unresolved-property",
    );
    expect(result.source_coverage.status).toBe("partial");
  });

  it("reports profile declarations without evaluating their activation", () => {
    const result = parse(
      pom(`
  <profiles>
    <profile>
      <id>integration</id>
      <activation><activeByDefault>true</activeByDefault></activation>
      <dependencies>
        <dependency>
          <groupId>org.testcontainers</groupId>
          <artifactId>junit-jupiter</artifactId>
          <version>1.20.1</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>`),
    );
    expect(result.profiles).toEqual([
      {
        id: "integration",
        active_by_default: true,
        source_pointer: "/profiles[0]/profile[0]",
      },
    ]);
    expect(result.dependencies[0]).toMatchObject({
      artifact_id: "junit-jupiter",
      profile: "integration",
    });
    expect(result.summary.profile_dependencies).toBe(1);
    expect(result.source_coverage.profile_activation).toBe("declarations-only");
  });
});

describe("repositories and diagnostics", () => {
  it("records declared repositories without contacting them", () => {
    const result = parse(
      pom(`
  <repositories>
    <repository>
      <id>internal</id>
      <url>https://repo.example.invalid/maven</url>
    </repository>
  </repositories>`),
    );
    expect(result.repositories).toEqual([
      {
        id: "internal",
        url: "https://repo.example.invalid/maven",
        layout: null,
        source_pointer: "/repositories[0]/repository[0]",
        line: expect.any(Number),
      },
    ]);
    expect(result.source_coverage.repositories).toBe("not-contacted");
  });

  it("keeps an incomplete dependency as a diagnostic, not a declaration", () => {
    const result = parse(
      pom(`
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
    </dependency>
  </dependencies>`),
    );
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "missing-required-field" }),
    ]);
  });

  it("reports a dependency declared twice with the same identity", () => {
    const result = parse(
      pom(`
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>dup</artifactId>
      <version>1.0</version>
    </dependency>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>dup</artifactId>
      <version>1.0</version>
    </dependency>
  </dependencies>`),
    );
    expect(result.dependencies).toHaveLength(2);
    expect(result.dependencies[0]?.dependency_id).toBe(
      result.dependencies[1]?.dependency_id,
    );
    // Declared order is preserved; identity collision stays visible to consumers.
    expect(result.dependencies[0]?.source_pointer).not.toBe(
      result.dependencies[1]?.source_pointer,
    );
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "duplicate-declaration",
    );
  });
});

describe("hostile documents", () => {
  it("rejects a document type declaration before parsing", () => {
    const document = parseXmlDocument(
      `<?xml version="1.0"?>
<!DOCTYPE project [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<project><modelVersion>4.0.0</modelVersion></project>`,
      { doctype: "reject", lineEndings: "normalize" },
    );
    expect(document.ok).toBe(false);
    expect(document.ok ? null : document.error.reason).toBe("doctype");
  });

  it("rejects malformed XML instead of inventing declarations", () => {
    const document = parseXmlDocument("<project><dependencies></project>", {
      doctype: "reject",
      lineEndings: "normalize",
    });
    expect(document.ok).toBe(false);
    expect(document.ok ? null : document.error.reason).toBe("malformed");
  });
});

describe("declaration fidelity", () => {
  it("matches dependency management on type and classifier, not coordinates alone", () => {
    const result = parse(
      pom(`
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.example</groupId>
        <artifactId>core</artifactId>
        <version>9.9.9</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>core</artifactId>
      <classifier>sources</classifier>
    </dependency>
  </dependencies>`),
    );
    const dependency = result.dependencies[0];
    expect(dependency?.version_origin).toEqual({ kind: "unresolved" });
    expect(dependency?.dependency_key).not.toBe(
      result.dependency_management[0]?.dependency_key,
    );
  });

  it("keeps an unresolved boolean unknown instead of declaring it false", () => {
    const result = parse(
      pom(`
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>optional-flag</artifactId>
      <version>1.0</version>
      <optional>\${flag}</optional>
    </dependency>
  </dependencies>`),
    );
    expect(result.dependencies[0]?.optional).toBeNull();
  });

  it("reads plugin repositories by their own element name", () => {
    const result = parse(
      pom(`
  <pluginRepositories>
    <pluginRepository>
      <id>plugins</id>
      <url>https://plugins.example.invalid/maven</url>
    </pluginRepository>
  </pluginRepositories>`),
    );
    expect(result.repositories.map((repository) => repository.id)).toEqual([
      "plugins",
    ]);
  });

  it("keeps profile dependency management with its profile", () => {
    const result = parse(
      pom(`
  <profiles>
    <profile>
      <id>ci</id>
      <dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>org.example</groupId>
            <artifactId>managed</artifactId>
            <version>2.0</version>
          </dependency>
        </dependencies>
      </dependencyManagement>
    </profile>
  </profiles>`),
    );
    expect(
      result.dependency_management.map((dependency) => dependency.profile),
    ).toEqual(["ci"]);
  });

  it("does not report profile dependencies as profile management", () => {
    const result = parse(
      pom(`
  <profiles>
    <profile>
      <id>ci</id>
      <dependencies>
        <dependency>
          <groupId>org.example</groupId>
          <artifactId>actual</artifactId>
          <version>1.0</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>`),
    );
    expect(
      result.dependencies.map((dependency) => dependency.artifact_id),
    ).toEqual(["actual"]);
    expect(result.dependency_management).toEqual([]);
  });

  it("substitutes property values literally and resolves past eight references", () => {
    const result = parse(
      pom(`
  <properties>
    <leaf>$$</leaf>
    <a>\${leaf}</a>
    <v0>x</v0>
    <v1>\${v0}</v1>
    <v2>\${v1}</v2>
    <v3>\${v2}</v3>
    <v4>\${v3}</v4>
    <v5>\${v4}</v5>
    <v6>\${v5}</v6>
    <v7>\${v6}</v7>
    <v8>\${v7}</v8>
    <v9>\${v8}</v9>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>uses-\${a}</artifactId>
      <version>\${v9}</version>
    </dependency>
  </dependencies>`),
    );
    const references = Object.fromEntries(
      result.property_references.map((reference) => [
        reference.name,
        reference,
      ]),
    );
    expect(references["a"]).toMatchObject({
      resolution: "resolved",
      resolved: "$$",
    });
    expect(references["v9"]).toMatchObject({
      resolution: "resolved",
      resolved: "x",
    });
  });
});

describe("property reference coverage", () => {
  it("reports a property cycle separately from an undeclared property", () => {
    const result = parse(
      pom(`
  <properties>
    <loop>\${loop}</loop>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>c</artifactId>
      <version>\${loop}</version>
    </dependency>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>d</artifactId>
      <version>\${absent}</version>
    </dependency>
  </dependencies>`),
    );
    const references = Object.fromEntries(
      result.property_references.map((reference) => [
        reference.name,
        reference,
      ]),
    );
    expect(references["loop"]?.resolution).toBe("cycle");
    expect(references["absent"]?.resolution).toBe("unresolved");
  });

  it("reports work-limit separately from a cycle when the allowance runs out", () => {
    const wide = Array.from({ length: 65 }, () => "${leaf}").join("");
    const result = parse(
      pom(`
  <properties>
    <leaf>x</leaf>
    <wide>${wide}</wide>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>wide</artifactId>
      <version>\${wide}</version>
    </dependency>
  </dependencies>`),
    );
    const references = Object.fromEntries(
      result.property_references.map((reference) => [
        reference.name,
        reference,
      ]),
    );
    expect(references["wide"]?.resolution).toBe("work-limit");
    expect(references["wide"]?.resolved).toBeNull();
  });

  it("collects references from parent coordinates, exclusions and property values", () => {
    const result = parse(
      pom(`
  <parent>
    <groupId>com.example</groupId>
    <artifactId>platform</artifactId>
    <version>\${revision}</version>
  </parent>
  <properties>
    <a>\${b}</a>
    <b>1.0</b>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>with-exclusion</artifactId>
      <version>1.0</version>
      <exclusions>
        <exclusion>
          <groupId>\${excluded.group}</groupId>
          <artifactId>removed</artifactId>
        </exclusion>
      </exclusions>
    </dependency>
  </dependencies>`),
    );
    expect(
      result.property_references.map((reference) => reference.name).sort(),
    ).toEqual(["b", "excluded.group", "revision"]);
  });
});
