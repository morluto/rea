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
  "preserves rustc hash capacity units through the public error contract",
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
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "resource_constraint",
        category: "resource_constraint",
        retryable: false,
        remediation: {
          action: expect.stringMatching(
            /rustc commit.path inventory.*fixed count/iu,
          ),
        },
        details: {
          operation: "inspect_rust_binary",
          resource: "capacity",
          reported_limits: { maximum_rustc_hashes: 64 },
        },
      });
      expect(parseMcpToolError(response).error.details).not.toHaveProperty(
        "reported_limits.maximum_bytes",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "recovers opt-in inferred Cargo crates and rustc banners over MCP and pages inferred_crates views",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rust-mcp-inferred-");
      const path = join(root, "stripped.elf");
      await writeFile(
        path,
        createRustImage({
          format: "elf",
          omitSection: true,
          readOnlyBytes: Buffer.from(
            [
              "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/lib.rs",
              "C:\\cargo\\registry\\src\\index.crates.io-6f17d22bba15001f\\x86_64-0.15.2\\src\\lib.rs",
              "/cargo/git/checkouts/quinn-0123456789abcdef/a1b2c3d/src/lib.rs",
            ].join("\0") + "\0",
            "latin1",
          ),
          elfComment: Buffer.from(
            "\0rustc version 1.85.0 (4d91de4e4 2025-02-17)\0",
            "latin1",
          ),
        }),
      );

      const defaultReply = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(defaultReply.isError).not.toBe(true);
      const defaultEvidence = toolContract(
        "inspect_rust_binary",
      ).outputSchema.parse(defaultReply.structuredContent);
      const defaultReport = rustBinarySchema.parse(
        defaultEvidence.normalized_result,
      );
      expect(defaultReport.inferred_crates).toBeUndefined();
      expect(defaultReport.rustc_versions).toBeUndefined();

      const refusedView = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: defaultEvidence.evidence_id,
          },
          view: { kind: "rust", collection: "inferred_crates" },
        },
      });
      expect(refusedView.isError).toBe(true);
      expect(parseMcpToolError(refusedView).error).toMatchObject({
        code: "invalid_request",
      });

      const optedIn = await client.callTool({
        name: "inspect_rust_binary",
        arguments: {
          path,
          include_inferred_crates: true,
          max_inferred_crates: 2,
        },
      });
      expect(optedIn.isError, JSON.stringify(optedIn.content)).not.toBe(true);
      const optedEvidence = toolContract(
        "inspect_rust_binary",
      ).outputSchema.parse(optedIn.structuredContent);
      const optedReport = rustBinarySchema.parse(
        optedEvidence.normalized_result,
      );
      expect(optedReport.inferred_crates).toMatchObject({
        evidence_kind: "inferred",
        discovered_count: 3,
        max_items: 2,
        truncated: true,
        items: [
          expect.objectContaining({ name: "tokio-util", version: "0.7.13" }),
          expect.objectContaining({ name: "x86_64", version: "0.15.2" }),
        ],
      });
      expect(optedReport.rustc_versions).toMatchObject({
        evidence_kind: "inferred",
        discovered_count: 1,
        truncated: false,
        items: [
          expect.objectContaining({
            banner: "rustc version 1.85.0 (4d91de4e4 2025-02-17)",
            version: "1.85.0",
            channel: "stable",
            commit_hash: "4d91de4e4",
            commit_date: "2025-02-17",
          }),
        ],
      });

      const paged = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: optedEvidence.evidence_id,
          },
          view: {
            kind: "rust",
            collection: "inferred_crates",
            contains: "tokio",
            fields: ["name", "version"],
          },
        },
      });
      expect(paged.isError, JSON.stringify(paged.content)).not.toBe(true);
      expect(paged.structuredContent).toMatchObject({
        normalized_result: {
          source_coverage: { inferred_crates: "truncated" },
          page: {
            collection: "inferred_crates",
            rows: [{ index: 0, name: "tokio-util", version: "0.7.13" }],
          },
        },
      });
    } finally {
      await session.close();
    }
  },
);
