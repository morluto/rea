import { ociImageLayoutSchema } from "../../../src/domain/oci/imageLayout.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { OCI_IMAGE_LAYOUT_TOOL_CONTRACTS } from "../../../src/contracts/oci/ociImageLayoutToolContracts.js";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { writeOciImageLayoutFixture } from "../../../src/oci/OciImageLayout.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const layoutContract = contractNamed(
  OCI_IMAGE_LAYOUT_TOOL_CONTRACTS,
  "inspect_oci_image_layout",
);
const completeLayoutEvidenceSchema = layoutContract.outputSchema.safeExtend({
  normalized_result: ociImageLayoutSchema,
});

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error(
      "OCI image-layout inspection must not start a deep provider",
    );
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_oci_image_layout and reads layout version",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_oci_image_layout",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const path = await createTestTempDirectory("rea-oci-mcp-");
      await writeOciImageLayoutFixture(path);
      const response = await client.callTool({
        name: "inspect_oci_image_layout",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeLayoutEvidenceSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.artifact.layout_version).toBe("1.0.0");
      expect(evidence.normalized_result.images[0]?.architecture).toBe("amd64");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_oci_image_layout",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_oci_image_layout",
        arguments: { path: "busybox.oci" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_oci_image_layout" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "refuses a file that is not an OCI image-layout directory",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-oci-mcp-file-");
      const path = join(root, "not-a-layout");
      await writeFile(path, "not a directory");
      const response = await client.callTool({
        name: "inspect_oci_image_layout",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        details: { operation: "inspect_oci_image_layout" },
      });
    } finally {
      await session.close();
    }
  },
);
