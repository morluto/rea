import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { RpmPackageMaterialization } from "../../../src/rpm/RpmPackageMaterialization.js";
import { createServer } from "../../../src/server/createServer.js";
import { RPM_PACKAGE_TOOL_CONTRACTS } from "../../../src/contracts/rpm/rpmPackageToolContracts.js";
import { rpmPackageSchema } from "../../../src/domain/rpm/package.js";
import {
  encodeRpmPackage,
  RPM_TAG,
  RPM_TYPE,
  rpmBinaryPackageFixture,
  rpmTruncatedHeaderFixture,
} from "../../../src/rpm/RpmPackage.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const inspectRpmPackageContract = RPM_PACKAGE_TOOL_CONTRACTS.find(
  (candidate) => candidate.name === "inspect_rpm_package",
);
if (inspectRpmPackageContract === undefined)
  throw new Error("Missing inspect_rpm_package contract");

const completeEvidenceSchema =
  inspectRpmPackageContract.outputSchema.safeExtend({
    normalized_result: rpmPackageSchema,
  });

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
  "keeps lead facts when the signature type is unsupported",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rpm-signature-");
      const path = join(root, "old-signature.rpm");
      await writeFile(
        path,
        rpmBinaryPackageFixture({ lead: { signatureType: 0 } }),
      );
      const response = await client.callTool({
        name: "inspect_rpm_package",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "unsupported_target",
        details: { operation: "inspect_rpm_package" },
      });
      expect(JSON.stringify(error)).toContain("demo-1.0.0-1");
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

for (const kind of ["values", "text"] as const) {
  mcpTest(
    `reports the fixed known-${kind} allowance through the registered MCP binding`,
    async ({ mcp }) => {
      const { client, session } = await connect(mcp);
      const quota = new RpmPackageMaterialization({ values: 1, textBytes: 3 });
      const reserveValues = quota.values.bind(quota);
      const decodeText = quota.text.bind(quota);
      const admission =
        kind === "values"
          ? vi
              .spyOn(RpmPackageMaterialization.prototype, "values")
              .mockImplementation(reserveValues)
          : vi
              .spyOn(RpmPackageMaterialization.prototype, "text")
              .mockImplementation(decodeText);
      try {
        const root = await createTestTempDirectory("rea-rpm-fixed-");
        const path = join(root, "small.rpm");
        const bytes = encodeRpmPackage({
          signatureTags: [],
          headerTags: [
            {
              tag: RPM_TAG.summary,
              type: RPM_TYPE.i18nString,
              strings: kind === "values" ? ["a", "b"] : ["AbCd"],
            },
          ],
        });
        await writeFile(path, bytes);
        const response = await client.callTool({
          name: "inspect_rpm_package",
          arguments: { path },
        });
        expect(response.isError).toBe(true);
        const error = parseMcpToolError(response).error;
        expect(error).toMatchObject({
          code: "resource_constraint",
          retryable: false,
          details: {
            resource: "memory",
            reported_limits: {
              boundary:
                kind === "values"
                  ? "materialized_values"
                  : "decoded_text_bytes",
              maximum: kind === "values" ? 1 : 3,
              required: kind === "values" ? 2 : 4,
            },
            diagnostics: { observed: { lead: { magic: "edabeedb" } } },
            partial_observation: {
              kind: "file-snapshot-hash",
              path,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        });
        expect(error.details?.refusal).toMatchObject({
          kind: "fixed_ceiling",
          allowance_kind: "parser",
          limit: kind === "values" ? 1 : 3,
        });
        expect(error.remediation?.action).not.toMatch(/Raise max_/u);
      } finally {
        admission.mockRestore();
        await session.close();
      }
    },
  );
}
