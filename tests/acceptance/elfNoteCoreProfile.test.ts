import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  corePrpsinfoNote,
  elfNoteFixture,
  gnuBuildIdNote,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for([
  { name: "System V control", osabi: 0, version: 0, linux: true },
  { name: "Linux control", osabi: 3, version: 0, linux: true },
  { name: "Solaris negative", osabi: 6, version: 0, linux: false },
  { name: "FreeBSD negative", osabi: 9, version: 0, linux: false },
  { name: "System V version negative", osabi: 0, version: 1, linux: false },
  { name: "Linux version negative", osabi: 3, version: 1, linux: false },
])(
  "qualifies CORE fields through CLI and stdio MCP: $name",
  async ({ osabi, version, linux }, { cli }) => {
    const root = await createTestTempDirectory("rea-elf-core-profile-");
    const path = join(root, "profile.core");
    const bytes = elfNoteFixture({
      type: 4,
      ownership: "program",
      notes: Buffer.concat([
        corePrpsinfoNote({ pid: 1234, uid: 70000 }),
        gnuBuildIdNote("0123456789abcdef"),
      ]),
    });
    bytes[7] = osabi;
    bytes[8] = version;
    await writeFile(path, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const output = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_elf_notes", { path });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const schema = toolContract("inspect_elf_notes").outputSchema;
    for (const raw of [output.json, response.structuredContent]) {
      const evidence = schema.parse(raw);
      expect(evidence.subject?.digest.sha256).toBe(hash);
      const report = evidence.normalized_result;
      expect(report.coverage).toMatchObject({
        status: "complete",
        examined_tables: 1,
        examined_entries: 2,
      });
      expect(report.entries[0]?.descriptor).toMatchObject({
        bytes: 136,
        sha256: createHash("sha256")
          .update(bytes.subarray(140, 276))
          .digest("hex"),
      });
      if (linux) {
        expect(report.entries[0]?.type_name).toBe("core_prpsinfo");
        expect(report.entries[0]?.core?.prpsinfo).toMatchObject({
          pid: 1234,
          uid: 70000,
        });
      } else {
        expect(report.entries[0]?.type_name).toBe("unknown");
        expect(report.entries[0]?.core).toBeNull();
        expect(report.limitations.join(" ")).toContain(
          `OSABI ${String(osabi)}`,
        );
      }
      expect(report.entries[1]?.gnu?.build_id_hex).toBe("0123456789abcdef");
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
