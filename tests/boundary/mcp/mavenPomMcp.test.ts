import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { MAVEN_POM_MAX_XML_NODES } from "../../../src/domain/mavenPom/mavenPom.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "projects Maven boolean declarations and bounded XML failures",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Unexpected deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const root = await createTestTempDirectory("rea-maven-mcp-");
      const path = join(root, "pom.xml");
      await writeFile(
        path,
        "<project><modelVersion>4.0.0</modelVersion><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><optional>${flag}</optional></dependency></dependencies></project>",
      );
      const response = await client.callTool({
        name: "inspect_maven_pom",
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const evidence = toolContract("inspect_maven_pom").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.dependencies[0]).toMatchObject({
        optional: null,
        optional_declared: "${flag}",
      });
      const bytes = `<project><modelVersion>4.0.0</modelVersion>${"<x/>".repeat(MAVEN_POM_MAX_XML_NODES)}</project>`;
      await writeFile(path, bytes);
      const failure = await client.callTool({
        name: "inspect_maven_pom",
        arguments: { path },
      });
      expect(failure.isError).toBe(true);
      expect(parseMcpToolError(failure)).toMatchObject({
        error: {
          code: "resource_constraint",
          details: {
            reported_limits: { max_xml_nodes: MAVEN_POM_MAX_XML_NODES },
            partial_observation: {
              kind: "file-snapshot-hash",
              path,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        },
      });
    } finally {
      await session.close();
    }
  },
);
