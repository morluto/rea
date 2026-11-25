import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { elfDependencyFixture } from "../../../src/native/elf/ElfDependencies.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

const dependenciesContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_elf_dependencies",
);

fileInspectionTest(
  "advertises inspect_elf_dependencies and reads a 32-bit big-endian image",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_elf_dependencies",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory("rea-elf-dependencies-mcp-");
    const path = join(root, "program");
    await writeFile(path, elfDependencyFixture({ bits: 32, little: false }));
    const response = await client.callTool({
      name: "inspect_elf_dependencies",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = dependenciesContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.parameters).toEqual({ path });
    const selected = await client.callTool({
      name: "inspect_elf_dependencies",
      arguments: { path, max_needed: 1024 },
    });
    expect(selected.isError).not.toBe(true);
    const explicitlySelected = dependenciesContract.outputSchema.parse(
      selected.structuredContent,
    );
    expect(explicitlySelected.parameters).toEqual({
      path,
      max_needed: 1024,
    });
    expect(explicitlySelected.evidence_id).not.toBe(evidence.evidence_id);
    expect(evidence.normalized_result).toMatchObject({
      format: "elf32",
      byte_order: "big",
      machine: 8,
      dynamic: { runpath: { tokens: ["$ORIGIN"] } },
    });
    expect(
      (evidence.normalized_result as { needed: { name: string | null }[] })
        .needed[0]?.name,
    ).toBe("libstdc++.so.6");
    expect(evidence.subject?.identity).toMatchObject({
      kind: "file",
      architecture: "mips",
    });
  },
);

fileInspectionTest(
  "reports a stripped image from program headers without a disassembler session",
  async ({ client }) => {
    const root = await createTestTempDirectory(
      "rea-elf-dependencies-stripped-mcp-",
    );
    const path = join(root, "program");
    await writeFile(path, elfDependencyFixture({ stripped: true }));
    const response = await client.callTool({
      name: "inspect_elf_dependencies",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = dependenciesContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result).toMatchObject({
      coverage: { status: "complete" },
      needed: [
        { name: "libstdc++.so.6" },
        { name: "libm.so.6" },
        { name: "libc.so.6" },
      ],
    });
  },
);
