import {
  OCI_IMAGE_LAYOUT_BUDGETS,
  ociImageLayoutSchema,
} from "../../../src/domain/oci/imageLayout.js";
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
import { testDeliveryEnvironment } from "../../support/completeEvidenceByDefault.js";

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

mcpTest(
  "returns a bounded summary when omitted detail exceeds the agent result budget and honors detail complete",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error(
        "OCI image-layout inspection must not start a deep provider",
      );
    });
    const environment = testDeliveryEnvironment(process.env, "budgeted");
    const client = await mcp.connect(
      createServer({ kind: "session", session }, { environment }),
      undefined,
      undefined,
      "budgeted",
    );
    try {
      const large = await createTestTempDirectory("rea-oci-mcp-large-");
      const labels = Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `org.example.label.${String(index).padStart(4, "0")}`,
          "x".repeat(120),
        ]),
      );
      await writeOciImageLayoutFixture(large, {
        config: { labels },
      });
      const summarized = await client.callTool({
        name: "inspect_oci_image_layout",
        arguments: { path: large },
      });
      expect(summarized.isError, JSON.stringify(summarized.content)).not.toBe(
        true,
      );
      const summary = layoutContract.outputSchema.parse(
        summarized.structuredContent,
      );
      expect(summary).toMatchObject({
        operation: "inspect_analysis_view",
        normalized_result: {
          kind: "summary",
          parent_operation: "inspect_oci_image_layout",
          summary: {
            artifact: { layout_version: "1.0.0" },
            image_count: 1,
          },
        },
      });
      const { parent_evidence_id: parentId } = summary.normalized_result as {
        readonly parent_evidence_id: string;
      };
      const complete = await client.callTool({
        name: "inspect_oci_image_layout",
        arguments: { path: large, detail: "complete" },
      });
      expect(complete.isError, JSON.stringify(complete.content)).not.toBe(true);
      const evidence = completeLayoutEvidenceSchema.parse(
        complete.structuredContent,
      );
      expect(evidence.evidence_id).toBe(parentId);
      expect(evidence.normalized_result.images[0]?.labels).toHaveLength(400);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports details.limit and details.refusal for an exhausted per-call OCI budget",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const path = await createTestTempDirectory("rea-oci-mcp-budget-");
      await writeOciImageLayoutFixture(path);
      const response = await client.callTool({
        name: "inspect_oci_image_layout",
        arguments: { path, max_entries: 1 },
      });
      expect(response.isError).toBe(true);
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          operation: "inspect_oci_image_layout",
          limit: {
            control_kind: "parameter",
            parameter: "max_entries",
            effective_value: 1,
            unit: "count",
            minimum: OCI_IMAGE_LAYOUT_BUDGETS.max_entries.minimum,
            maximum: OCI_IMAGE_LAYOUT_BUDGETS.max_entries.maximum,
            default_value: OCI_IMAGE_LAYOUT_BUDGETS.max_entries.default_value,
            required_value: 2,
            applies_at: "next_call",
          },
          refusal: {
            kind: "adjustable_budget",
            operation: "inspect_oci_image_layout",
            control: "max_entries",
            effective_value: 1,
            unit: "count",
            required_value: 2,
          },
        },
      });
    } finally {
      await session.close();
    }
  },
);
