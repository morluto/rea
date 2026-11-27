import { vsixPackageSchema } from "../../../src/domain/vsix/vsixPackage.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipReader } from "@zip.js/zip.js";
import { expect, vi } from "vitest";
import { VSIX_PACKAGE_TOOL_CONTRACTS } from "../../../src/contracts/vsix/vsixPackageToolContracts.js";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { vsixPackageFixture } from "../../../src/vsix/VsixPackage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";
import {
  testDeliveryEnvironment,
  type TestDelivery,
} from "../../support/completeEvidenceByDefault.js";

const vsixContract = contractNamed(
  VSIX_PACKAGE_TOOL_CONTRACTS,
  "inspect_vsix_package",
);
const completeVsixEvidenceSchema = vsixContract.outputSchema.safeExtend({
  normalized_result: vsixPackageSchema,
});

const connect = async (
  mcp: TestMcp,
  delivery: TestDelivery = "completeEvidenceByDefault",
) => {
  const session = createTestBinarySession(() => {
    throw new Error("VS Code vsix inspection must not start a deep provider");
  });
  const environment = testDeliveryEnvironment(process.env, delivery);
  const client = await mcp.connect(
    createServer({ kind: "session", session }, { environment }),
    undefined,
    undefined,
    delivery,
  );
  return { client, session };
};

mcpTest(
  "advertises inspect_vsix_package and reads package identity",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp, "budgeted");
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_vsix_package",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeVsixEvidenceSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.vsix_identity?.id).toBe("demo.hello");
      expect(evidence.normalized_result.vsix_identity?.version).toBe("1.2.3");
      expect(evidence.normalized_result.package_identity?.name).toBe("hello");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "summarizes an oversized VSIX by default and retains complete Evidence",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp, "budgeted");
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "large.vsix");
      const extraMembers = Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `extension/out/generated/member-${index}.js`,
          "x",
        ]),
      );
      await writeFile(path, await vsixPackageFixture({ extraMembers }));

      const summarized = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      const summary = vsixContract.outputSchema.parse(
        summarized.structuredContent,
      );
      expect(summary.operation).toBe("inspect_analysis_view");
      const view = summary.normalized_result;
      if (!("kind" in view) || view.kind !== "summary")
        throw new Error("Expected the retained VSIX summary");
      expect(view).toMatchObject({
        parent_operation: "inspect_vsix_package",
        summary: { vsix_identity: { id: "demo.hello" } },
      });

      const page = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: view.parent_evidence_id,
          },
          view: { kind: "evidence-json", offset: 0 },
        },
      });
      expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
      expect(page.structuredContent).toMatchObject({
        normalized_result: {
          kind: "evidence-json",
          parent_evidence_id: view.parent_evidence_id,
        },
      });

      const explicit = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path, detail: "summary" },
      });
      expect(
        vsixContract.outputSchema.parse(explicit.structuredContent),
      ).toMatchObject({ evidence_id: summary.evidence_id });

      const complete = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path, detail: "complete" },
      });
      const evidence = completeVsixEvidenceSchema.parse(
        complete.structuredContent,
      );
      expect(evidence.evidence_id).toBe(view.parent_evidence_id);
      expect(evidence.normalized_result.contents).toHaveLength(
        view.summary.content_count,
      );
      expect(view.summary.content_count).toBeGreaterThanOrEqual(400);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "bounds a 100 KiB manifest description in the default summary while retaining complete Evidence",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp, "budgeted");
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-long-desc-");
      const path = join(root, "long-description.vsix");
      const longDescription = "D".repeat(100 * 1024);
      const vsixmanifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="demo.hello" Version="1.2.3" Publisher="demo" />
    <DisplayName>Hello Demo</DisplayName>
    <Description xml:space="preserve">${longDescription}</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
  </Assets>
</PackageManifest>
`;
      await writeFile(path, await vsixPackageFixture({ vsixmanifest }));

      const summarized = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      expect(summarized.isError, JSON.stringify(summarized.content)).not.toBe(
        true,
      );
      expect(
        Buffer.byteLength(JSON.stringify(summarized.structuredContent), "utf8"),
      ).toBeLessThan(32 * 1024);
      const summary = vsixContract.outputSchema.parse(
        summarized.structuredContent,
      );
      expect(summary.operation).toBe("inspect_analysis_view");
      const view = summary.normalized_result;
      if (!("kind" in view) || view.kind !== "summary")
        throw new Error("Expected the retained VSIX summary");
      expect(view.summary.text_truncated).toBe(true);
      expect(view.summary.vsix_identity?.description?.length).toBeLessThan(
        1024,
      );
      expect(view.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("truncated"),
          expect.stringContaining(view.parent_evidence_id),
        ]),
      );

      const complete = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path, detail: "complete" },
      });
      const evidence = completeVsixEvidenceSchema.parse(
        complete.structuredContent,
      );
      expect(evidence.evidence_id).toBe(view.parent_evidence_id);
      expect(evidence.normalized_result.vsix_identity?.description).toBe(
        longDescription,
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports structured parameter limit facts when max_entries is exceeded",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-limit-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path, max_entries: 1 },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          operation: "inspect_vsix_package",
          reported_limits: {
            boundary: "max_entries",
            maximum: 1,
            required: 2,
          },
          limit: {
            control_kind: "parameter",
            parameter: "max_entries",
            effective_value: 1,
            unit: "count",
            applies_at: "next_call",
          },
        },
      });
      expect(error.details?.limit).not.toHaveProperty("required_value");
      expect(error.details?.refusal).not.toHaveProperty("required_value");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_vsix_package",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path: "pkg.vsix" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_vsix_package" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "advises a fixed allowance, not more memory, for a Zstandard window refusal",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    const refusal = Object.assign(new Error("Frame requires too much memory"), {
      code: "ZSTD_error_frameParameter_windowTooLarge",
    });
    const original = ZipReader.prototype.getEntriesGenerator;
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* (this: ZipReader<unknown>, options) {
        for await (const entry of original.call(this, options)) {
          if (entry.filename === "extension.vsixmanifest" && !entry.directory) {
            entry.compressionMethod = 93;
            entry.getData = () => Promise.reject(refusal);
          }
          yield entry;
        }
        return true;
      });
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
      });
      expect(error.remediation.action).toContain(
        "Recompress the member with a window of at most 128 MiB",
      );
      expect(error.details?.refusal).toMatchObject({
        kind: "fixed_ceiling",
        limit: 128 * 1024 * 1024,
        unit: "bytes",
      });
    } finally {
      enumeration.mockRestore();
      await session.close();
    }
  },
);

mcpTest(
  "reports a Zstandard dictionary member as an unsupported target, not a malformed package",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    const refusal = Object.assign(new Error("Dictionary mismatch"), {
      code: "ZSTD_error_dictionary_wrong",
    });
    const original = ZipReader.prototype.getEntriesGenerator;
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* (this: ZipReader<unknown>, options) {
        for await (const entry of original.call(this, options)) {
          if (entry.filename === "extension.vsixmanifest" && !entry.directory) {
            entry.compressionMethod = 93;
            entry.getData = () => Promise.reject(refusal);
          }
          yield entry;
        }
        return true;
      });
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      const { error } = parseMcpToolError(response);
      expect(error.code).toBe("unsupported_target");
      expect(error.message).toMatch(/Zstandard dictionary/u);
    } finally {
      enumeration.mockRestore();
      await session.close();
    }
  },
);
