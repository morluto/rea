import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { MAVEN_GRADLE_METADATA_TOOL_CONTRACTS } from "../../src/contracts/java/mavenGradleMetadataToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "../../src/contracts/sessionToolContracts.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
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
    await writeFile(
      path,
      `<project><modelVersion>4.0.0</modelVersion><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent></project>`,
    );
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
    expect(cliEvidence.normalized_result.unresolved).toEqual(expected);
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

cliTest(
  "preserves metadata caller selections and transport URL provenance through CLI, MCP and retained records",
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
          formatVersion: "1.1",
          component: { group: "g", module: "m", version: "1" },
          variants: [
            {
              name: "api",
              "available-at": {
                url,
                group: "g",
                module: "other",
                version: "1",
              },
            },
          ],
        }),
      ],
    ] as const) {
      const path = join(root, file);
      await writeFile(path, source);
      for (const maximum of [undefined, 1048576, 65536]) {
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
        expect(JSON.stringify(evidence)).toContain(
          "HTTPS://Example.invalid/a/../b?token=visible",
        );
        const retained = await call("get_evidence_bundle", {
          detail: "complete",
        });
        expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
        const bundle = parseEvidenceBundle(
          bundleOutputSchema.parse(retained.structuredContent).result,
        );
        expect(
          bundle.records.find(
            (record) => record.evidence_id === evidence.evidence_id,
          ),
        ).toEqual(evidence);
      }
    }
  },
);

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
