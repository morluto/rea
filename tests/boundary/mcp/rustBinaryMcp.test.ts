import { rustBinarySchema } from "../../../src/domain/rust/rustBinary.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  createRustImage,
  createRustHashOverflowImage,
  createRustWasmModule,
  createWasmSectionFlood,
} from "../../fixtures/rust/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

fileInspectionTest(
  "advertises inspect_rust_binary and reads an embedded dependency list",
  async ({ client }) => {
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
  },
);

fileInspectionTest(
  "preserves dependency Evidence and compiler-prefix coverage through MCP",
  async ({ client }) => {
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
  },
);

fileInspectionTest(
  "refuses a WebAssembly section walk past max_wasm_sections",
  async ({ client }) => {
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
        limit: {
          control_kind: "parameter",
          parameter: "max_wasm_sections",
          effective_value: 65_536,
          unit: "count",
          minimum: 1,
          maximum: 16_777_216,
          default_value: 65_536,
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_rust_binary",
          control: "max_wasm_sections",
          effective_value: 65_536,
          unit: "count",
          default_value: 65_536,
        },
      },
    });

    await writeFile(path, complete.subarray(0, complete.length - 1));
    const truncated = await client.callTool({
      name: "inspect_rust_binary",
      arguments: { path },
    });
    expect(parseMcpToolError(truncated).error).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_rust_binary",
        failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
      },
    });
  },
);
