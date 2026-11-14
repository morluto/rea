import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { rpmPackageSchema } from "../../../src/domain/rpm/package.js";
import {
  rpmBinaryPackageFixture,
  rpmTruncatedHeaderFixture,
} from "../../../src/rpm/RpmPackage.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const completeEvidenceSchema = toolContract(
  "inspect_rpm_package",
).outputSchema.safeExtend({ normalized_result: rpmPackageSchema });

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("RPM inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_rpm_package and reads package identity",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_rpm_package",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-rpm-mcp-");
      const path = join(root, "demo.rpm");
      await writeFile(path, rpmBinaryPackageFixture());
      const response = await client.callTool({
        name: "inspect_rpm_package",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeEvidenceSchema.parse(response.structuredContent);
      expect(evidence.normalized_result.package.name).toBe("demo");
      expect(evidence.normalized_result.package.epoch).toBe(2);
      expect(evidence.normalized_result.payload.listing_source).toBe("header");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_rpm_package",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_rpm_package",
        arguments: { path: "demo.rpm" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_rpm_package" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports a foreign magic as an unsupported target rather than a parse",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rpm-unsupported-");
      const path = join(root, "not-a-package.rpm");
      const foreign = Buffer.from("not an rpm");
      await writeFile(path, foreign);
      const response = await client.callTool({
        name: "inspect_rpm_package",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "unsupported_target",
        details: { operation: "inspect_rpm_package" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "keeps lead facts when a truncated header is refused",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rpm-truncated-");
      const path = join(root, "truncated.rpm");
      const bytes = rpmTruncatedHeaderFixture();
      await writeFile(path, bytes);
      const response = await client.callTool({
        name: "inspect_rpm_package",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_rpm_package",
          partial_observation: {
            kind: "file-snapshot-hash",
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      });
      expect(JSON.stringify(error)).toContain("edabeedb");
    } finally {
      await session.close();
    }
  },
);
