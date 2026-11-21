import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { rustBinarySchema } from "../../../src/domain/rust/rustBinary.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  createRustImage,
  createRustHashOverflowImage,
  createRustWasmModule,
  createWasmSectionFlood,
} from "../../fixtures/rust/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Rust metadata must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_rust_binary and reads an embedded dependency list",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_rust_binary",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-rust-mcp-");
      const path = join(root, "sample.elf");
      await writeFile(path, createRustImage({ format: "elf" }));
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        response.structuredContent,
      );
      expect(
        rustBinarySchema.parse(evidence.normalized_result).auditable_metadata
          ?.packages,
      ).toEqual([
        expect.objectContaining({ name: "itoa", version: "1.0.18" }),
        expect.objectContaining({
          name: "sample",
          version: "0.1.0",
          root: true,
        }),
      ]);
      const missing = join(root, "plain.elf");
      await writeFile(
        missing,
        createRustImage({ format: "pe", omitSection: true }),
      );
      const absent = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path: missing },
      });
      expect(absent.isError).not.toBe(true);
      const absentEvidence = toolContract(
        "inspect_rust_binary",
      ).outputSchema.parse(absent.structuredContent);
      expect(
        rustBinarySchema.parse(absentEvidence.normalized_result)
          .auditable_metadata,
      ).toBeNull();
      // The listed tools let the client check WebAssembly's null word size
      // against the advertised output schema, not only the source contract.
      const module = join(root, "sample.wasm");
      await writeFile(module, createRustWasmModule());
      const wasm = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path: module },
      });
      expect(wasm.isError, JSON.stringify(wasm.content)).not.toBe(true);
      expect(
        rustBinarySchema.parse(
          toolContract("inspect_rust_binary").outputSchema.parse(
            wasm.structuredContent,
          ).normalized_result,
        ),
      ).toMatchObject({
        format: "wasm",
        bits: null,
        auditable_metadata: { section_name: ".dep-v0", root_package_index: 1 },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "projects an embedded Rust dependency list as CycloneDX",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rust-mcp-cyclonedx-");
      const path = join(root, "sample.elf");
      await writeFile(path, createRustImage({ format: "elf" }));
      const inspected = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(
        true,
      );
      const parent = parseEvidence(inspected.structuredContent);
      const viewed = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.evidence_id,
          },
          view: { kind: "cyclonedx" },
        },
      });
      expect(viewed.isError, JSON.stringify(viewed.content)).not.toBe(true);
      const result = analysisViewResultSchema.parse(
        parseEvidence(viewed.structuredContent).normalized_result,
      );
      if (result.kind !== "cyclonedx")
        throw new Error("Expected a CycloneDX view");
      const document = result.document;
      expect(document).toMatchObject({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        compositions: [{ aggregate: "unknown" }],
      });
      const documentText = JSON.stringify(document);
      expect(documentText).toContain("pkg:cargo/itoa@1.0.18");
      // sample is source "local". pkg:cargo names a crates.io package.
      expect(documentText).not.toContain("pkg:cargo/sample@0.1.0");
      const sample = document.components.find(
        (component) => component.name === "sample",
      );
      expect(sample).toMatchObject({
        name: "sample",
        version: "0.1.0",
        "bom-ref": "rust-package:1",
      });
      expect(sample).not.toHaveProperty("purl");
      expect(sample?.properties).toEqual(
        expect.arrayContaining([{ name: "rea:cargo:source", value: "local" }]),
      );
      expect(
        result.unknowns.filter((message) =>
          ["sample", "0.1.0", "local"].every((fact) => message.includes(fact)),
        ),
      ).toHaveLength(1);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_rust_binary",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path: "sample" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_rust_binary" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "preserves dependency Evidence and compiler-prefix coverage through MCP",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rust-mcp-");
      const path = join(root, "many-hashes.elf");
      await writeFile(path, createRustHashOverflowImage());
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        response.structuredContent,
      );
      const report = rustBinarySchema.parse(evidence.normalized_result);
      expect(report.auditable_metadata?.packages).toHaveLength(2);
      expect(report.rustc_commit?.coverage).toEqual({
        status: "partial",
        reason: "max_rustc_hashes",
        effective_limit: 64,
        limit: expect.objectContaining({
          control_kind: "parameter",
          parameter: "max_rustc_hashes",
        }),
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "refuses a WebAssembly section walk past its fixed work allowance",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rust-mcp-");
      const path = join(root, "many-sections.wasm");
      const complete = createWasmSectionFlood(65_537);
      await writeFile(path, complete);
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          operation: "inspect_rust_binary",
          resource: "cpu",
          reported_limits: { boundary: "max_wasm_sections", maximum: 65_536 },
          refusal: {
            kind: "fixed_ceiling",
            allowance_kind: "work",
            limit: 65_536,
            unit: "sections",
          },
        },
      });

      await writeFile(path, complete.subarray(0, complete.length - 1));
      const truncated = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(parseMcpToolError(truncated).error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_rust_binary",
          issues: [{ path: ["path"], reason: "invalid_format" }],
        },
      });
    } finally {
      await session.close();
    }
  },
);
