import { crc32 } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { DEFAULT_INSPECT_ELF_DEBUG_LINK_ENTRIES } from "../../../src/domain/native/elfDebugLink.js";
import {
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
} from "../../../src/native/elf/ElfDebugLink.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

const debugLinkContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_elf_debug_link",
);

fileInspectionTest(
  "advertises inspect_elf_debug_link and reads an ELF32 big-endian image",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_elf_debug_link",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory("rea-elf-debug-link-mcp-");
    const path = join(root, "prog");
    await writeFile(
      path,
      elfDebugLinkFixture({ bits: 32, little: false, machine: 20 }),
    );
    const response = await client.callTool({
      name: "inspect_elf_debug_link",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = debugLinkContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result).toMatchObject({
      format: "elf32",
      byte_order: "big",
      machine: 20,
      debuglink: {
        status: "present",
        crc32_hex: "12345678",
        filename: {
          text: FIXTURE_DEBUG_NAME,
          trust: "observed-untrusted",
        },
      },
      build_id: { hex: FIXTURE_BUILD_ID_HEX },
    });
    const identity = evidence.subject.identity;
    expect(identity.kind).toBe("file");
    if (identity.kind === "file") expect(identity.architecture).toBe("powerpc");
    expect(evidence.normalized_result.verification).toBeNull();
    expect(evidence.parameters).toEqual({ path });
    const explicit = await client.callTool({
      name: "inspect_elf_debug_link",
      arguments: {
        path,
        max_entries: DEFAULT_INSPECT_ELF_DEBUG_LINK_ENTRIES,
      },
    });
    expect(explicit.isError).not.toBe(true);
    const selected = debugLinkContract.outputSchema.parse(
      explicit.structuredContent,
    );
    expect(selected.parameters).toEqual({
      path,
      max_entries: DEFAULT_INSPECT_ELF_DEBUG_LINK_ENTRIES,
    });
    expect(selected.normalized_result).toEqual(evidence.normalized_result);
    expect(selected.evidence_id).not.toBe(evidence.evidence_id);
  },
);

fileInspectionTest(
  "verifies one caller-selected debug file",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-debug-link-mcp-match-");
    const candidate = elfDebugCandidateFixture();
    const imagePath = join(root, "prog");
    const candidatePath = join(root, "prog.debug");
    await writeFile(
      imagePath,
      elfDebugLinkFixture({
        debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, crc32(candidate), true),
      }),
    );
    await writeFile(candidatePath, candidate);
    const response = await client.callTool({
      name: "inspect_elf_debug_link",
      arguments: { path: imagePath, candidate_path: candidatePath },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = debugLinkContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result.verification?.status).toBe("matches");
    expect(evidence.normalized_result.candidate?.debug_info).toBe("present");
    expect(evidence.locations).toContainEqual({
      kind: "artifact-path",
      path: candidatePath,
    });
    expect("_meta" in response ? response._meta : undefined).toMatchObject({
      provenance: { untrusted_content: true, source: "analysis_target" },
    });
  },
);
