import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { elfNoteFixture } from "../../src/native/elf/ElfNotes.fixture.js";
import { INLINE_EVIDENCE_MCP_ENVIRONMENT } from "../../scripts/lib/mcp-verification-environment.mjs";
import { elfFrameAllowanceFixture } from "../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createIl2cppMetadataFixture } from "../fixtures/il2cpp/metadata.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("reports an ELF section-name frame refusal through each native diagnostic", async () => {
  const root = await createTestTempDirectory("rea-native-elf-frame-cap-");
  const path = join(root, "image.elf");
  const primary = join(root, "primary.elf");
  const metadata = join(root, "global-metadata.dat");
  const bytes = elfFrameAllowanceFixture();
  await writeFile(path, bytes);
  await writeFile(primary, elfNoteFixture());
  await writeFile(metadata, createIl2cppMetadataFixture().bytes);
  const { call } = await connectLocalToolsMcp(INLINE_EVIDENCE_MCP_ENVIRONMENT);
  const operations = [
    "inspect_binary_hardening",
    "inspect_elf_debug_link",
    "inspect_elf_unwind_ranges",
    "inspect_kernel_module",
    "inspect_native_exports",
    "inspect_native_initializers",
    "inspect_go_binary",
    "inspect_rust_binary",
  ] as const;
  const setAllowance = async (value: number) => {
    const result = await call("update_analysis_settings", {
      changes: [{ setting: "zstd.max_frames", action: "set", value }],
    });
    expect(result.isError).not.toBe(true);
  };

  await setAllowance(1);
  for (const operation of [...operations, "inspect_il2cpp_metadata"]) {
    const settings = await call("inspect_analysis_settings", { operation });
    expect(settings.structuredContent, operation).toMatchObject({
      settings: expect.arrayContaining([
        expect.objectContaining({ setting: "zstd.max_frames" }),
      ]),
    });
    const result = await call(
      operation,
      operation === "inspect_il2cpp_metadata"
        ? { path: metadata, binary_path: path }
        : { path },
    );
    expect(parseMcpToolError(result).error, operation).toMatchObject({
      code: "resource_constraint",
      details: {
        operation,
        resource: "cpu",
        reported_limits: {
          boundary: "zstd.max_frames",
          maximum: 1,
          required: 2,
        },
        limit: {
          setting: "zstd.max_frames",
          effective_value: 1,
          source: "runtime",
          unit: "count",
        },
      },
    });
  }

  const candidate = await call("inspect_elf_debug_link", {
    path: primary,
    candidate_path: path,
  });
  expect(candidate.isError).not.toBe(true);
  expect(candidate.structuredContent).toMatchObject({
    normalized_result: {
      candidate: {
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        format: "elf64",
        debug_info: "unknown",
        symtab: "unknown",
      },
      limitations: expect.arrayContaining([
        expect.stringContaining("zstd.max_frames"),
      ]),
    },
  });

  await setAllowance(2);
  for (const operation of operations) {
    const result = await call(operation, { path });
    expect(
      result.isError,
      `${operation}: ${JSON.stringify(result.content)}`,
    ).not.toBe(true);
  }
});
