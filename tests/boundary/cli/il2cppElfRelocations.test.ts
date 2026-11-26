import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { il2cppMetadataSchema } from "../../../src/domain/il2cpp/il2cppMetadata.js";
import {
  createElfFixture,
  createIl2cppBinaryFixture,
  FIXTURE_BINARY_BASE,
  FIXTURE_METHOD_ADDRESSES,
} from "../../fixtures/il2cpp/binary.js";
import { createLinkedIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const report = (value: unknown) =>
  il2cppMetadataSchema.parse(
    toolContract("inspect_il2cpp_metadata").outputSchema.parse(value)
      .normalized_result,
  );

cliTest(
  "links ELF metadata past ABS64 and GLOB_DAT records through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-elf-symbols-");
    const metadataPath = join(root, "global-metadata.dat");
    await writeFile(metadataPath, createLinkedIl2cppMetadataFixture().bytes);
    const { call } = await connectLocalToolsMcp();
    for (const machine of [183, 62]) {
      const bytes = createElfFixture(createIl2cppBinaryFixture(), {
        machine,
        symbolDefinition: { value: FIXTURE_BINARY_BASE + 0xe00n },
        unresolvedRelocations: [
          ...[0xe00, 0xe08, 0xe10].map((offset) => ({
            offset,
            kind: machine === 183 ? 257 : 1,
          })),
          ...[0xe20, 0xe28, 0xe30].map((offset) => ({
            offset,
            kind: machine === 183 ? 1025 : 6,
          })),
        ],
      });
      const binaryPath = join(root, `libil2cpp-${machine}.so`);
      await writeFile(binaryPath, bytes);
      const result = await cli.run({
        arguments: [
          "inspect-il2cpp-metadata",
          metadataPath,
          "--binary",
          binaryPath,
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const linked = report(result.json);
      expect(linked.method_addresses.map(({ address }) => address)).toEqual(
        FIXTURE_METHOD_ADDRESSES.map((value) =>
          typeof value === "bigint" ? `0x${value.toString(16)}` : null,
        ),
      );
      expect(linked.binary?.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(linked.limitations).toContainEqual(
        expect.stringContaining("runtime symbol interposition"),
      );

      const mcp = await call("inspect_il2cpp_metadata", {
        path: metadataPath,
        binary_path: binaryPath,
        detail: "complete",
      });
      expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
      expect(report(mcp.structuredContent)).toEqual(linked);
      expect((await readFile(binaryPath)).equals(bytes)).toBe(true);
    }

    // A declared but undefined symbol still cannot disprove a competing module.
    const unresolved = createElfFixture(createIl2cppBinaryFixture(), {
      symbolDefinition: { value: FIXTURE_BINARY_BASE + 0xe00n, section: 0 },
      unresolvedRelocations: [0xe00, 0xe08, 0xe10].map((offset) => ({
        offset,
        kind: 1025,
      })),
    });
    const unresolvedPath = join(root, "unresolved.so");
    await writeFile(unresolvedPath, unresolved);
    const refused = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        metadataPath,
        "--binary",
        unresolvedPath,
        "--json",
      ],
    });
    const partial = {
      inventory_status: "not-returned-as-complete",
      selected_binary: {
        path: unresolvedPath,
        sha256: createHash("sha256").update(unresolved).digest("hex"),
      },
    };
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "input_conflict",
      details: { partial_observation: { normalized_result: partial } },
    });
    const mcpRefused = await call("inspect_il2cpp_metadata", {
      path: metadataPath,
      binary_path: unresolvedPath,
      detail: "complete",
    });
    expect(mcpRefused.isError).toBe(true);
    const mcpError = parseMcpToolError(mcpRefused).error;
    expect(mcpError.code).toBe("input_conflict");
    const reference = z
      .object({
        partial_observation: z.object({
          kind: z.literal("retained-evidence"),
          evidence_id: z.string(),
        }),
      })
      .parse(mcpError.details).partial_observation;
    const retainedReply = await call("get_evidence_bundle", {
      detail: "complete",
    });
    expect(retainedReply.isError).not.toBe(true);
    const bundle = toolContract("get_evidence_bundle").outputSchema.parse(
      retainedReply.structuredContent,
    ).result;
    if ("kind" in bundle)
      throw new Error("Expected complete retained Evidence");
    const retained = parseEvidence(
      bundle.records.find(
        ({ evidence_id }) => evidence_id === reference.evidence_id,
      ),
    );
    expect(retained.normalized_result).toMatchObject(partial);
    const metadataOnly = await call("inspect_il2cpp_metadata", {
      path: metadataPath,
      detail: "complete",
    });
    expect(metadataOnly.isError).not.toBe(true);
    expect(report(metadataOnly.structuredContent).binary).toBeNull();
  },
);
