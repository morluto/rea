import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfDebugImage,
  elfImage,
  macho64,
  namedUnit,
} from "../../src/native/dwarf/DwarfUnits.fixture.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../fixtures/universalMacho.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest("reports a compile unit through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-dwarf-units-cli-");
  const path = join(root, "program");
  await writeFile(path, elfDebugImage(namedUnit({ name: "main.c" })));
  const result = await cli.run({
    arguments: ["inspect-dwarf-units", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_dwarf_units").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.units[0]?.name).toEqual({
    state: "present",
    value: "main.c",
  });
  expect(evidence.normalized_result.coverage.status).toBe("complete");
  expect(evidence.subject?.format).toBe("elf");
});

cliTest(
  "resolves a relative path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dwarf-units-cli-rel-");
    await writeFile(join(root, "plain"), elfImage());
    const result = await cli.run({
      arguments: ["inspect-dwarf-units", "plain", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_dwarf_units").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.coverage.status).toBe("no_debug_info");
    expect(evidence.subject?.local_path).toBe(join(root, "plain"));
  },
);

cliTest("requires an architecture for a universal Mach-O", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-dwarf-units-cli-fat-");
  const path = join(root, "universal");
  await writeFile(
    path,
    universalMacho([
      {
        bytes: macho64({ cpuType: CPU_X86_64 }),
        cpuType: CPU_X86_64,
        cpuSubtype: 0,
      },
      {
        bytes: macho64({ cpuType: CPU_ARM64 }),
        cpuType: CPU_ARM64,
        cpuSubtype: 0,
      },
    ]).bytes,
  );
  const result = await cli.run({
    arguments: ["inspect-dwarf-units", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_dwarf_units" },
  });
});
