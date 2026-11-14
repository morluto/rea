import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mavenGradleMetadataSchema } from "../../../src/domain/java/mavenGradleMetadata.js";
import {
  gradleModuleFixture,
  mavenPomFixture,
} from "../../../src/java/MavenGradleMetadata.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const completeEvidenceSchema = toolContract(
  "inspect_maven_gradle_metadata",
).outputSchema.safeExtend({ normalized_result: mavenGradleMetadataSchema });

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error(
      "Maven/Gradle metadata inspection must not start a deep provider",
    );
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_maven_gradle_metadata and reports a real POM",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_maven_gradle_metadata",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-maven-mcp-");
      const path = join(root, "pom.xml");
      await writeFile(path, mavenPomFixture);
      const response = await client.callTool({
        name: "inspect_maven_gradle_metadata",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeEvidenceSchema.parse(response.structuredContent);
      const report = evidence.normalized_result;
      expect(report.format).toBe("maven-pom");
      expect(report.coordinates.artifact_id).toBe("demo");
      expect(report.dependency_management[0]?.bom_import).toBe(true);
      expect(report.limitations.join(" ")).toContain(
        "without running Maven or Gradle",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports Gradle module variants from inspect_maven_gradle_metadata",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-gradle-mcp-");
      const path = join(root, "demo-1.2.3.module");
      await writeFile(path, gradleModuleFixture);
      const response = await client.callTool({
        name: "inspect_maven_gradle_metadata",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const report = completeEvidenceSchema.parse(
        response.structuredContent,
      ).normalized_result;
      expect(report.format).toBe("gradle-module");
      expect(report.coordinates.group_id).toBe("com.example");
      expect(report.gradle?.format_version).toBe("1.1");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_maven_gradle_metadata",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_maven_gradle_metadata",
        arguments: { path: "pom.xml" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_maven_gradle_metadata" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports a foreign file as an unsupported target rather than a parse",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-maven-unsupported-");
      const path = join(root, "notes.txt");
      const foreign = Buffer.from("hello world\n", "utf8");
      await writeFile(path, foreign);
      const response = await client.callTool({
        name: "inspect_maven_gradle_metadata",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "unsupported_target",
        details: { operation: "inspect_maven_gradle_metadata" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest("reports malformed XML as invalid input", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const root = await createTestTempDirectory("rea-maven-malformed-");
    const path = join(root, "pom.xml");
    const corrupt = Buffer.from("<project><artifactId>demo</project>", "utf8");
    await writeFile(path, corrupt);
    const response = await client.callTool({
      name: "inspect_maven_gradle_metadata",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
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
  } finally {
    await session.close();
  }
});
