import { constants as bufferConstants } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createRustImage } from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { lazyLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const connectLocalToolsMcp = lazyLocalToolsMcp();

cliTest(
  "refuses a compressed dependency section above max_compressed_dependency_bytes on CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-rust-cli-dependency-budget-",
    );
    const { client, call } = await connectLocalToolsMcp();
    const path = join(root, "selected.elf");
    await writeFile(path, createRustImage({ format: "elf" }));
    const result = await cli.run({
      arguments: [
        "inspect-rust-binary",
        path,
        "--max-compressed-dependency-bytes",
        "1",
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    const response = await call("inspect_rust_binary", {
      path,
      max_compressed_dependency_bytes: 1,
    });
    const mcpError = parseMcpToolError(response).error;
    const limit = {
      control_kind: "parameter",
      parameter: "max_compressed_dependency_bytes",
      effective_value: 1,
      unit: "bytes",
      minimum: 1,
      maximum: bufferConstants.MAX_LENGTH,
      default_value: 1024 * 1024,
      applies_at: "next_call",
    };
    const refusal = {
      kind: "adjustable_budget",
      operation: "inspect_rust_binary",
      control: "max_compressed_dependency_bytes",
      effective_value: 1,
      unit: "bytes",
      range: { minimum: 1, maximum: bufferConstants.MAX_LENGTH },
      default_value: 1024 * 1024,
    };
    expect(mcpError).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_rust_binary",
        resource: "memory",
        reported_limits: {
          boundary: "max_compressed_dependency_bytes",
          maximum: 1,
        },
        limit,
        refusal,
      },
    });
    expect(mcpError.details?.limit).not.toHaveProperty("cli_flag");
    expect(mcpError.details).toMatchObject({
      limit: { required_value: expect.any(Number) },
    });
    expect(result.json).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_rust_binary",
        resource: "memory",
        limit: { ...limit, cli_flag: "--max-compressed-dependency-bytes" },
        refusal,
      },
    });
    await client.ping();
  },
);
