import { writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  compressedKernelModuleContainer,
  kernelModuleFixture,
} from "../../../src/native/elf/KernelModule.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Kernel module inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "keeps valid omitted modinfo fields distinct from malformed syntax and recovers on the same connection",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-kernel-module-text-mcp-");
      const path = join(root, "text.ko");
      const key = "k".repeat(257);
      const value = "v".repeat(4097);
      await writeFile(
        path,
        kernelModuleFixture({ modinfo: Buffer.from(`${key}=${value}\0`) }),
      );
      const inspect = async (budgets: Record<string, number> = {}) => {
        const response = await client.callTool({
          name: "inspect_kernel_module",
          arguments: { path, ...budgets },
        });
        expect(response.isError, JSON.stringify(response.content)).not.toBe(
          true,
        );
        return toolContract("inspect_kernel_module").outputSchema.parse(
          response.structuredContent,
        );
      };
      const initial = await inspect();
      const omitted = initial.normalized_result.modinfo?.entries[0];
      expect(omitted).toMatchObject({
        status: "observed",
        reason: null,
        key: null,
        value: null,
        omitted_fields: ["key", "value"],
        raw_hex: null,
      });
      expect(initial.normalized_result.coverage.status).toBe("partial");
      expect(initial.normalized_result.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("max_modinfo_key_bytes at least 257"),
          expect.stringContaining("max_modinfo_value_bytes at least 4097"),
        ]),
      );
      const recovered = await inspect({
        max_modinfo_key_bytes: 257,
        max_modinfo_value_bytes: 4097,
      });
      expect(recovered.subject).toEqual(initial.subject);
      expect(recovered.normalized_result.modinfo?.entries[0]).toEqual({
        ...omitted,
        key,
        value,
        omitted_fields: [],
      });
      expect(recovered.normalized_result.coverage.status).toBe("complete");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "advertises inspect_kernel_module and reads an ELF32 big-endian module",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_kernel_module",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-kernel-module-mcp-");
      const path = join(root, "demo.ko");
      await writeFile(path, kernelModuleFixture({ bits: 32, little: false }));
      const response = await client.callTool({
        name: "inspect_kernel_module",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result).toMatchObject({
        format: "elf32",
        byte_order: "big",
        machine: 20,
        applicability: "applicable",
      });
      expect(evidence.subject?.architecture).toBe("powerpc");
      expect(evidence.normalized_result.modinfo?.entries[0]).toMatchObject({
        key: "license",
        value: "GPL",
      });
      expect(evidence.normalized_result.versions?.entries[1]?.crc_hex).toBe(
        "90abcdef",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports duplicate sections as partial in MCP Evidence",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory(
        "rea-kernel-module-duplicate-mcp-",
      );
      const path = join(root, "duplicate.ko");
      await writeFile(
        path,
        kernelModuleFixture({
          sharedNameSections: {
            name: ".exit.text",
            count: 1,
            body: Buffer.from([1, 2, 3]),
          },
        }),
      );
      const response = await client.callTool({
        name: "inspect_kernel_module",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const outputSchema = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_kernel_module",
      )?.outputSchema;
      if (outputSchema === undefined) throw new Error("Missing output schema");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      expect(ajv.validateSchema(outputSchema as AnySchema)).toBe(true);
      expect(
        ajv.compile(outputSchema as AnySchema)(response.structuredContent),
      ).toBe(true);
      const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.coverage.status).toBe("partial");
      expect(evidence.normalized_result.exit_text).toMatchObject({
        status: "present",
        bytes: 1,
      });
      expect(evidence.normalized_result.limitations).toContain(
        "Multiple .exit.text sections are declared; the first is examined.",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_kernel_module",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_kernel_module",
        arguments: { path: "demo.ko" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_kernel_module" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports a zstd container as an unsupported kernel-module target",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-kernel-module-zstd-mcp-");
      const path = join(root, "demo.ko.zst");
      await writeFile(path, compressedKernelModuleContainer("zstd"));
      const response = await client.callTool({
        name: "inspect_kernel_module",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result).toMatchObject({
        applicability: "unsupported",
        compression: { codec: "zstd", status: "unsupported" },
        next_probe: { operation: "external_decompression" },
      });
    } finally {
      await session.close();
    }
  },
);
