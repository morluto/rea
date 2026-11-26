import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { MAVEN_GRADLE_METADATA_TOOL_CONTRACTS } from "../../src/contracts/java/mavenGradleMetadataToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "../../src/contracts/sessionToolContracts.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import {
  connectLocalToolsMcp,
  lazyLocalToolsMcp,
} from "../fixtures/localToolsMcp.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
  mavenPropertyValuesFixture,
  qualifiedMavenPropertiesFixture,
} from "../../src/java/MavenGradleMetadata.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const outputSchema = contractNamed(
  MAVEN_GRADLE_METADATA_TOOL_CONTRACTS,
  "inspect_maven_gradle_metadata",
).outputSchema;
const bundleOutputSchema = contractNamed(
  SESSION_TOOL_CONTRACTS,
  "get_evidence_bundle",
).outputSchema;

cliTest(
  "refuses a POM at report_limits.xml_nodes and reports it when raised through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-report-limits-");
    const path = join(root, "pom.xml");
    await writeFile(path, mavenPomFixture);
    const command = ["inspect-maven-gradle-metadata", path, "--json"];
    const limit = {
      control_kind: "parameter",
      parameter: "report_limits.xml_nodes",
      effective_value: 8,
      unit: "count",
      minimum: 1,
      default_value: 1_048_576,
      applies_at: "next_call",
    };
    const refused = await cli.run({
      arguments: [...command, "--report-limits", '{"xml_nodes":8}'],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: { limit },
      remediation: {
        action: expect.stringContaining("report_limits.xml_nodes"),
      },
    });
    const raised = await cli.run({
      arguments: [...command, "--report-limits", '{"xml_nodes":100000}'],
    });
    expect(raised.exitCode, raised.stderr).toBe(0);
    expect(outputSchema.parse(raised.json).parameters).toMatchObject({
      report_limits: { xml_nodes: 100_000 },
    });
    const { call } = await connectLocalToolsMcp();
    const mcpRefused = await call("inspect_maven_gradle_metadata", {
      path,
      report_limits: { xml_nodes: 8 },
    });
    expect(mcpRefused.isError).toBe(true);
    expect(parseMcpToolError(mcpRefused).error).toMatchObject({
      details: { limit },
    });
    const mcpRaised = await call("inspect_maven_gradle_metadata", {
      path,
      report_limits: { xml_nodes: 100_000 },
    });
    expect(mcpRaised.isError, JSON.stringify(mcpRaised)).not.toBe(true);
  },
);

cliTest(
  "preserves Maven property value characters through CLI, MCP and retained Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-property-values-");
    const path = join(root, "pom.xml");
    const bytes = Buffer.from(mavenPropertyValuesFixture);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const cliEvidence = outputSchema.parse(result.json);
    const report = cliEvidence.normalized_result;
    expect(report.properties).toEqual([
      {
        name: "revision",
        value: "\u00a01.2.3\u00a0",
        value_credentials_redacted: false,
      },
      {
        name: "dependency.version",
        value: "\ufeff2.0\ufeff",
        value_credentials_redacted: false,
      },
      {
        name: "marker",
        value: "\u00a0\ufeff",
        value_credentials_redacted: false,
      },
      {
        name: "plain",
        value: "ordinary value",
        value_credentials_redacted: false,
      },
      { name: "blank", value: null, value_credentials_redacted: false },
      {
        name: "mirror",
        value: "\u00a0https://example.invalid/repository\ufeff",
        value_credentials_redacted: true,
      },
    ]);
    expect(report.coordinates.version).toBe("${revision}");
    expect(report.dependencies[0]?.version).toBe("${dependency.version}");
    expect(report.unresolved).toEqual([
      {
        kind: "property",
        reference: "${revision}",
        field: "version",
        owner: "project",
        index: null,
      },
      {
        kind: "property",
        reference: "${dependency.version}",
        field: "version",
        owner: "dependency",
        index: 0,
      },
    ]);
    expect(report.artifact).toEqual({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(report.coverage).toEqual({
      status: "complete",
      examined_bytes: bytes.length,
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_maven_gradle_metadata", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toEqual(report);
    const retained = await call("get_evidence_bundle", { detail: "complete" });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    const bundle = parseEvidenceBundle(
      bundleOutputSchema.parse(retained.structuredContent).result,
    );
    expect(
      bundle.records.find(
        (record) => record.evidence_id === evidence.evidence_id,
      ),
    ).toEqual(evidence);
    expect(JSON.stringify([cliEvidence, response, retained])).not.toContain(
      "fixture-password",
    );
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "distinguishes POM declaration namespaces and preserves qualified property keys through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-property-keys-");
    const path = join(root, "pom.xml");
    const bytes = Buffer.from(
      qualifiedMavenPropertiesFixture
        .replace("<groupId>", "<a:groupId>foreign</a:groupId><groupId>")
        .replace(
          "<dependencies>",
          "<dependencies><a:dependency><artifactId>foreign</artifactId></a:dependency>",
        ),
    );
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const cliEvidence = outputSchema.parse(result.json);
    const report = cliEvidence.normalized_result;
    expect(report.coordinates.group_id).toBe("example");
    expect(report.dependencies).toHaveLength(1);
    expect(report.properties).toEqual([
      { name: "revision", value: "0", value_credentials_redacted: false },
      { name: "a:revision", value: "11", value_credentials_redacted: false },
      { name: "b:revision", value: "22", value_credentials_redacted: false },
    ]);
    expect(report.coordinates.version).toBe("${a:revision}");
    expect(report.dependencies[0]?.version).toBe("${b:revision}");
    expect(report.unresolved).toEqual([
      {
        kind: "property",
        reference: "${a:revision}",
        field: "version",
        owner: "project",
        index: null,
      },
      {
        kind: "property",
        reference: "${b:revision}",
        field: "version",
        owner: "dependency",
        index: 0,
      },
    ]);
    expect(report.artifact).toEqual({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_maven_gradle_metadata", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toEqual(report);
    const retained = await call("get_evidence_bundle", { detail: "complete" });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    const bundle = parseEvidenceBundle(
      bundleOutputSchema.parse(retained.structuredContent).result,
    );
    expect(
      bundle.records.find(
        (record) => record.evidence_id === evidence.evidence_id,
      ),
    ).toEqual(evidence);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "reports a missing child artifact independently of parent group and version through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-parent-gap-");
    const path = join(root, "pom.xml");
    const source = `<project><modelVersion>4.0.0</modelVersion><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent></project>`;
    await writeFile(path, source);
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const expected = [
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
    ];
    const cliEvidence = outputSchema.parse(result.json);
    expect(cliEvidence.normalized_result).toMatchObject({
      coordinates: {
        group_id: null,
        artifact_id: null,
        version: null,
        packaging: null,
      },
      artifact: { bytes: Buffer.byteLength(source) },
      coverage: { examined_bytes: Buffer.byteLength(source) },
      unresolved: expected,
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_maven_gradle_metadata", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
    const retained = await call("get_evidence_bundle", { detail: "complete" });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    const bundle = parseEvidenceBundle(
      bundleOutputSchema.parse(retained.structuredContent).result,
    );
    expect(
      bundle.records.find(
        (record) => record.evidence_id === evidence.evidence_id,
      ),
    ).toEqual(evidence);
  },
);

const redactedMetadataUrl = "HTTPS://Example.invalid/a/../b?token=visible";
const recordedGradleDeclarations = {
  format: "gradle-module",
  coordinates: { group_id: " g", artifact_id: "m ", version: " 1 " },
  gradle: {
    format_version: " 1.1 ",
    created_by_gradle: "8.0 ",
    variants: [
      { name: "api", category: " platform ", usage: " api " },
      {
        name: "redirected",
        available_at: {
          group_id: " g",
          artifact_id: "other ",
          version: " 1 ",
          url: `\u00a0\t${redactedMetadataUrl}\ufeff`,
          url_credentials_redacted: true,
        },
      },
    ],
  },
  dependencies: [
    {
      group_id: "g ",
      artifact_id: " ranged",
      version: " [1,2) ",
      version_kind: "literal",
      platform: false,
      gradle_version: { requires: " [1,2) ", rejects: [" 2 "] },
    },
    {
      artifact_id: "shorthand",
      version: " 2.+ ",
      version_kind: "literal",
      platform: false,
      gradle_version: { requires: " 2.+ " },
    },
  ],
};

cliTest(
  "preserves metadata selections and recorded declarations through CLI, MCP and retained Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-metadata-provenance-");
    const { call } = await connectLocalToolsMcp();
    const url = "HTTPS://user:password@Example.invalid/a/../b?token=visible";
    for (const [file, source] of [
      [
        "pom.xml",
        mavenPomFixture.replace(
          "<revision>",
          `<download.url>${url}</download.url><revision>`,
        ),
      ],
      [
        "demo.module",
        JSON.stringify({
          formatVersion: " 1.1 ",
          component: { group: " g", module: "m ", version: " 1 " },
          createdBy: { gradle: { version: "8.0 " } },
          variants: [
            {
              name: "api",
              attributes: {
                "org.gradle.category": " platform ",
                "org.gradle.usage": " api ",
              },
              dependencies: [
                {
                  group: "g ",
                  module: " ranged",
                  version: { requires: " [1,2) ", rejects: [" 2 "] },
                },
                { group: "g", module: "shorthand", version: " 2.+ " },
              ],
            },
            {
              name: "redirected",
              "available-at": {
                url: `\u00a0\t${url}\ufeff`,
                group: " g",
                module: "other ",
                version: " 1 ",
              },
            },
          ],
        }),
      ],
    ] as const) {
      const path = join(root, file);
      await writeFile(path, source);
      const budgets =
        file === "pom.xml" ? [undefined] : [undefined, 1048576, 65536];
      const observed: ReturnType<typeof outputSchema.parse>[] = [];
      for (const maximum of budgets) {
        const input = {
          path,
          ...(maximum === undefined ? {} : { max_file_bytes: maximum }),
        };
        const output = await cli.run({
          arguments: [
            "inspect-maven-gradle-metadata",
            `./${file}`,
            "--json",
            ...(maximum === undefined
              ? []
              : ["--max-file-bytes", String(maximum)]),
          ],
          cwd: root,
        });
        expect(output.exitCode, output.stderr).toBe(0);
        const cliEvidence = outputSchema.parse(output.json);
        expect(cliEvidence.caller_input_path).toBe(`./${file}`);
        expect(cliEvidence.parameters).toEqual(input);
        const response = await call("inspect_maven_gradle_metadata", input);
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const evidence = outputSchema.parse(response.structuredContent);
        expect(evidence.parameters).toEqual(input);
        expect(evidence.normalized_result).toEqual(
          cliEvidence.normalized_result,
        );
        expect(JSON.stringify(evidence)).not.toContain("user:password");
        if (observed.length > 0)
          expect(evidence.normalized_result).toEqual(
            observed[0]?.normalized_result,
          );
        observed.push(evidence);
        if (maximum !== budgets.at(-1)) continue;
        const report = evidence.normalized_result;
        if (file === "pom.xml") {
          expect(report.format).toBe("maven-pom");
          expect(report.properties).toContainEqual(
            expect.objectContaining({
              name: "download.url",
              value: redactedMetadataUrl,
              value_credentials_redacted: true,
            }),
          );
        } else {
          expect(report).toMatchObject(recordedGradleDeclarations);
          expect(report.limitations).toContainEqual(
            expect.stringContaining("unfamiliar format version"),
          );
        }
      }
      await unlink(path);
      const retained = await call("get_evidence_bundle", {
        detail: "complete",
      });
      expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
      const bundle = parseEvidenceBundle(
        bundleOutputSchema.parse(retained.structuredContent).result,
      );
      for (const evidence of observed)
        expect(
          bundle.records.find(
            ({ evidence_id }) => evidence_id === evidence.evidence_id,
          ),
        ).toEqual(evidence);
    }
  },
);

cliTest(
  "classifies a BOM import by its managed declaration through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-maven-cli-");
    const path = join(root, "pom.xml");
    const bytes = Buffer.from(
      mavenPomFixture.replace(
        "</dependencyManagement>\n  <dependencies>",
        `</dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>example</groupId><artifactId>direct-pom</artifactId><version>1</version>
      <type>pom</type><scope>import</scope>
    </dependency>`,
      ),
      "utf8",
    );
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
      origin: "dependencyManagement",
      scope: "import",
      type: "pom",
      bom_import: true,
    });
    expect(report.dependencies[0]).toMatchObject({
      artifact_id: "direct-pom",
      origin: "dependencies",
      scope: "import",
      type: "pom",
      bom_import: false,
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
    const version = "[2.17\u00a0beta,2.18)";
    await writeFile(path, gradleModuleFixture.replace("[2.17,2.18)", version));
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
      version,
      version_kind: "range",
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

const malformedPomMcp = lazyLocalToolsMcp();

cliTest.for([
  {
    label: "invalid XML syntax",
    source: "<project><artifactId>demo</project>",
    issue: "not well-formed XML",
  },
  {
    label: "markup inside the project version",
    source:
      '<project xmlns:x="urn:example"><artifactId>demo</artifactId><version>1<x:ignored/>2</version></project>',
    issue: "<version> must contain text without nested elements",
  },
  {
    label: "markup inside a property value",
    source:
      "<project><artifactId>demo</artifactId><properties><revision>1<ignored/>2</revision></properties></project>",
    issue: "<revision> must contain text without nested elements",
  },
])(
  "preserves the selected file identity when refusing $label",
  async ({ source, issue }, { cli }) => {
    const root = await createTestTempDirectory("rea-maven-cli-malformed-");
    const path = join(root, "pom.xml");
    const bytes = Buffer.from(source, "utf8");
    await writeFile(path, bytes);
    const expected = {
      code: "unsupported_target",
      details: {
        operation: "inspect_maven_gradle_metadata",
        failure_kind: "malformed",
        reason: expect.stringContaining(issue),
        partial_observation: {
          kind: "file-snapshot-hash",
          path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    };
    const result = await cli.run({
      arguments: ["inspect-maven-gradle-metadata", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject(expected);
    const { call } = await malformedPomMcp();
    const response = await call("inspect_maven_gradle_metadata", { path });
    expect(parseMcpToolError(response).error).toMatchObject(expected);
  },
);
