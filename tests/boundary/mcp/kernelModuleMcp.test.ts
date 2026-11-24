import { fileIdentity } from "../../fixtures/evidenceSubject.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  crc32Array,
  extendedVersionSections,
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
        return response.structuredContent;
      };
      const initialReply = await inspect();
      const outputSchema = canonicalOutputSchema("inspect_kernel_module");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      expect(ajv.validateSchema(outputSchema as AnySchema)).toBe(true);
      expect(ajv.compile(outputSchema as AnySchema)(initialReply)).toBe(true);
      const parse = toolContract("inspect_kernel_module").outputSchema.parse;
      const initial = parse(initialReply);
      const omitted = initial.normalized_result.modinfo?.entries[0];
      expect(omitted).toMatchObject({
        status: "observed",
        reason: null,
        key: null,
        value: null,
        omitted_fields: ["key", "value"],
        raw_hex: null,
      });
      expect(() =>
        parse({
          ...initial,
          normalized_result: {
            ...initial.normalized_result,
            modinfo: {
              ...initial.normalized_result.modinfo,
              entries: [
                {
                  ...omitted,
                  status: "malformed",
                  reason: "modinfo_field_exceeds_limit",
                },
              ],
            },
          },
        }),
      ).toThrow();
      expect(initial.normalized_result.coverage.status).toBe("partial");
      expect(initial.normalized_result.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("max_modinfo_key_bytes at least 257"),
          expect.stringContaining("max_modinfo_value_bytes at least 4097"),
        ]),
      );
      // The result records each control by contract field; MCP text names no
      // CLI option.
      expect(initial.normalized_result.modinfo?.omission_limits).toEqual([
        {
          control_kind: "parameter",
          parameter: "max_modinfo_key_bytes",
          effective_value: 256,
          unit: "bytes",
          minimum: 1,
          maximum: 536870912,
          default_value: 256,
          applies_at: "next_call",
        },
        expect.objectContaining({
          parameter: "max_modinfo_value_bytes",
          effective_value: 4096,
          default_value: 4096,
        }),
      ]);
      expect(initial.normalized_result.limitations.join(" ")).not.toContain(
        "--max-modinfo",
      );
      const recovered = parse(
        await inspect({
          max_modinfo_key_bytes: 257,
          max_modinfo_value_bytes: 4097,
        }),
      );
      expect(recovered.subject).toEqual(initial.subject);
      expect(recovered.normalized_result.modinfo?.entries[0]).toEqual({
        ...omitted,
        key,
        value,
        omitted_fields: [],
      });
      expect(recovered.normalized_result.coverage.status).toBe("complete");
      expect(recovered.normalized_result.modinfo).not.toHaveProperty(
        "omission_limits",
      );
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
      expect(fileIdentity(evidence.subject).architecture).toBe("powerpc");
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
  "advertises and validates ksymtab strings, kcrctab, and CONFIG_EXTENDED_MODVERSIONS through MCP",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-kernel-module-ext-mcp-");
      const path = join(root, "ext.ko");
      const ext = extendedVersionSections(
        [{ crc: 0xabcdef12, name: `rust_${"x".repeat(70)}` }],
        false,
      );
      await writeFile(
        path,
        kernelModuleFixture({
          bits: 64,
          little: false,
          versions: null,
          ksymtabStrings: Buffer.from("exported_sym\0", "latin1"),
          kcrctab: crc32Array([0x01020304], false),
          versionExtNames: ext.names,
          versionExtCrcs: ext.crcs,
        }),
      );
      const response = await client.callTool({
        name: "inspect_kernel_module",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const outputSchema = canonicalOutputSchema("inspect_kernel_module");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      expect(
        ajv.compile(outputSchema as AnySchema)(response.structuredContent),
      ).toBe(true);
      const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
        response.structuredContent,
      );
      expect(
        evidence.normalized_result.extended_versions?.entries[0],
      ).toMatchObject({
        crc_hex: "abcdef12",
        status: "observed",
      });
      expect(
        evidence.normalized_result.ksymtab?.kcrctab?.entries[0]?.crc_hex,
      ).toBe("01020304");
      expect(
        evidence.normalized_result.ksymtab?.strings?.entries[0]?.value,
      ).toBe("exported_sym");
    } finally {
      await session.close();
    }
  },
);
