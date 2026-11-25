import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  bzImageGzipFixture,
  truncatedKernelConfigFixture,
} from "../../../src/native/elf/KernelBuildConfig.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

const contract = toolContract("inspect_kernel_build_config");

fileInspectionTest(
  "advertises inspect_kernel_build_config and reads a bzImage gzip payload",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_kernel_build_config",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory("rea-kernel-config-mcp-");
    const path = join(root, "bzImage");
    await writeFile(path, bzImageGzipFixture());
    const response = await client.callTool({
      name: "inspect_kernel_build_config",
      arguments: { path, name: "CONFIG_MODULE_SIG" },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = contract.outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toMatchObject({
      payload: { container: "bzimage", codec: "gzip", status: "inflated" },
      banner: { status: "present", version: "6.6.0" },
      config: {
        status: "present",
        matched_count: 1,
        entries: [{ name: "CONFIG_MODULE_SIG", kind: "m" }],
      },
    });
  },
);

fileInspectionTest(
  "reports a truncated IKCFG member as incomplete",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-kernel-config-trunc-mcp-");
    const path = join(root, "vmlinux");
    await writeFile(path, truncatedKernelConfigFixture());
    const response = await client.callTool({
      name: "inspect_kernel_build_config",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = contract.outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toMatchObject({
      config: { status: "incomplete", reason: "config_gzip_truncated" },
      coverage: { status: "partial" },
    });
  },
);
