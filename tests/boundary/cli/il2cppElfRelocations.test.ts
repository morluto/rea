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
  "links ELF metadata past ABS64, GLOB_DAT and JUMP_SLOT records through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-elf-symbols-");
    const metadataPath = join(root, "global-metadata.dat");
    await writeFile(metadataPath, createLinkedIl2cppMetadataFixture().bytes);
    const { call } = await connectLocalToolsMcp();
    // A defined symbol derives its link-image value. An undefined one with no
    // value, like an Android import, binds another object, so its unknown
    // value cannot name a competing module.
    for (const [machine, symbol, definition] of [
      [183, "defined", { value: FIXTURE_BINARY_BASE + 0xe00n }],
      [62, "defined", { value: FIXTURE_BINARY_BASE + 0xe00n }],
      [183, "imported", { value: 0n, section: 0 }],
      [62, "imported", { value: 0n, section: 0 }],
    ] as const) {
      const bytes = createElfFixture(createIl2cppBinaryFixture(), {
        machine,
        symbolDefinition: definition,
        unresolvedRelocations: [
          ...[0xe00, 0xe08, 0xe10].map((offset) => ({
            offset,
            kind: machine === 183 ? 257 : 1,
          })),
          ...[0xe20, 0xe28, 0xe30].map((offset) => ({
            offset,
            kind: machine === 183 ? 1025 : 6,
          })),
          ...[0xe40, 0xe48, 0xe50].map((offset) => ({
            offset,
            kind: machine === 183 ? 1026 : 7,
          })),
        ],
      });
      const binaryPath = join(root, `libil2cpp-${machine}-${symbol}.so`);
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

    // An undefined symbol with a value, an executable's canonical PLT address,
    // can bind inside the image, so it still cannot disprove a competing module.
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
      code: "invalid_request",
      details: { partial_observation: { normalized_result: partial } },
    });
    const mcpRefused = await call("inspect_il2cpp_metadata", {
      path: metadataPath,
      binary_path: unresolvedPath,
      detail: "complete",
    });
    expect(mcpRefused.isError).toBe(true);
    const mcpError = parseMcpToolError(mcpRefused).error;
    expect(mcpError.code).toBe("invalid_request");
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

cliTest.for([
  {
    name: "CodeRegistration module array",
    fixture: { duplicateCodeRegistration: true },
    pointerOffset: 0x688,
    ambiguity: "A possible CodeRegistration has an unresolved module array",
  },
  {
    name: "MetadataRegistration type table",
    fixture: { duplicateMetadataRegistration: true },
    pointerOffset: 0x8b8,
    ambiguity:
      "A possible MetadataRegistration has unresolved candidate fields",
  },
])(
  "rules out a competing $name only when its pointer is imported",
  async ({ fixture, pointerOffset, ambiguity }, { cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-elf-registration-");
    const metadataPath = join(root, "global-metadata.dat");
    const binaryPath = join(root, "libil2cpp.so");
    await writeFile(metadataPath, createLinkedIl2cppMetadataFixture().bytes);

    const image = createIl2cppBinaryFixture(fixture);
    // Replace the duplicate's local pointer without emitting a second relocation
    // at the same address. Its matching counts and other pointers stay intact.
    image.writeBigUInt64LE(0n, pointerOffset);
    const inspect = async (value: bigint) => {
      await writeFile(
        binaryPath,
        createElfFixture(image, {
          symbolDefinition: { value, section: 0 },
          unresolvedRelocations: [{ offset: pointerOffset, kind: 1025 }],
        }),
      );
      return cli.run({
        arguments: [
          "inspect-il2cpp-metadata",
          metadataPath,
          "--binary",
          binaryPath,
          "--json",
        ],
      });
    };

    const linked = await inspect(0n);
    expect(linked.exitCode, JSON.stringify(linked.json)).toBe(0);
    expect(report(linked.json).binary).toMatchObject({
      code_gen_modules_field: `0x${(FIXTURE_BINARY_BASE + 0x600n).toString(16)}`,
      types_field: `0x${(FIXTURE_BINARY_BASE + 0x830n).toString(16)}`,
    });

    const unresolved = await inspect(FIXTURE_BINARY_BASE + 0xe00n);
    expect(unresolved.exitCode).toBe(1);
    expect(JSON.stringify(unresolved.json)).toContain(ambiguity);
  },
);
