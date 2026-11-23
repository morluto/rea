import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfNote,
  elfNoteFixture,
  gnuPropertyNote,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "preserves GNU property order refusals through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gnu-property-order-");
    const call = await cli.sharedMcpCall!();
    for (const [label, secondType, wide] of [
      ["sorted", 0xc0008002, false],
      ["descending", 0xc0000001, false],
      ["duplicate", 0xc0000002, false],
      ["window-sorted", 0xc0000002, true],
      ["window-duplicate", 1, true],
    ] as const) {
      const descriptor = Buffer.alloc(65552);
      descriptor.writeUInt32LE(1, 0);
      descriptor.writeUInt32LE(65528, 4);
      descriptor.writeUInt32LE(4, 65540);
      descriptor.writeUInt32LE(3, 65544);
      const note = wide
        ? elfNote("GNU", 5, descriptor, true, 8)
        : gnuPropertyNote();
      note.writeUInt32LE(secondType, wide ? 16 + 65536 : note.length - 16);
      const bytes = elfNoteFixture({
        notes: note,
        ownership: "program",
        alignment: 8,
      });
      const path = join(root, `${label}.elf`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-binary-hardening", path, "--json"],
      });
      const response = await call("inspect_binary_hardening", { path });
      if (label === "sorted" || label === "window-sorted") {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(response.isError).not.toBe(true);
        const contract = toolContract("inspect_binary_hardening");
        const cliReport = contract.outputSchema.parse(
          result.json,
        ).normalized_result;
        const mcpReport = contract.outputSchema.parse(
          response.structuredContent,
        ).normalized_result;
        expect(mcpReport).toEqual(cliReport);
        expect(cliReport.format).toBe("elf");
      } else {
        expect(result.exitCode, result.stderr).toBe(1);
        expect(result.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          details: {
            partial_observation: {
              kind: "file-snapshot-hash",
              path,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        });
        expect(parseMcpToolError(response)).toEqual({ error: result.json });
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);
