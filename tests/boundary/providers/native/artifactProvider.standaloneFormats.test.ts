import { projectCliAnalysisResult } from "../../../../src/cli/projectCliAnalysisResult.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { bfltFile } from "../../../../src/domain/bfltExecutable.fixture.js";
import { windowsShortcutBytes } from "../../../fixtures/binaryDiagnostics/windowsShortcut.js";
import { createSqliteDatabaseFixture } from "../../../fixtures/sqlite/database.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { buildFv } from "../../../fixtures/uefiImage.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import {
  arArchive,
  debPackageFixture,
} from "../../../../src/deb/DebPackage.fixture.js";
import { artifactInspectionResultSchema } from "../../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";

const { runProviderAnalysis } = createDirectAnalysis({});

/** A v17 FDT holding only an empty root node. */
const devicetreeBlob = (): Buffer => {
  const structure = Buffer.alloc(16);
  structure.writeUInt32BE(1, 0); // FDT_BEGIN_NODE, empty name padded to 4
  structure.writeUInt32BE(2, 8); // FDT_END_NODE
  structure.writeUInt32BE(9, 12); // FDT_END
  const reservations = Buffer.alloc(16);
  const header = Buffer.alloc(40);
  const structureOffset = header.length + reservations.length;
  const stringsOffset = structureOffset + structure.length;
  for (const [offset, value] of [
    [0, 0xd00dfeed],
    [4, stringsOffset],
    [8, structureOffset],
    [12, stringsOffset],
    [16, header.length],
    [20, 17],
    [24, 16],
    [32, 0],
    [36, structure.length],
  ] as const)
    header.writeUInt32BE(value, offset);
  return Buffer.concat([header, reservations, structure]);
};

/** A CPython 3.11 pyc header followed by a marshalled None. */
const pythonPyc = (): Buffer => {
  const bytes = Buffer.alloc(17);
  bytes.writeUInt16LE(3495, 0);
  bytes.write("\r\n", 2, "latin1");
  bytes.write("N", 16, "latin1");
  return bytes;
};

const inspect = async (path: string) => {
  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  );
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  expect(
    inspection.unexplored_branches.map(({ next_probe }) => next_probe),
  ).toEqual(inspection.next_probes);
  const identity = evidence.subject?.identity;
  return {
    format: inspection.subject.root_format,
    subject: identity?.kind === "file" ? identity.format : identity?.kind,
    probes: inspection.next_probes.map(({ operation, authority }) => ({
      operation,
      authority,
    })),
  };
};

const writeBytes =
  (file: string, bytes: () => Uint8Array) =>
  async (directory: string): Promise<string> => {
    const path = join(directory, file);
    await writeFile(path, bytes());
    return path;
  };

it.each([
  {
    name: "a Windows shortcut",
    create: writeBytes("target.lnk", () => windowsShortcutBytes()),
    format: "windows-shortcut",
    operation: "inspect_windows_shortcut",
  },
  {
    name: "a Python pyc",
    create: writeBytes("module.pyc", pythonPyc),
    format: "python-pyc",
    operation: "inspect_python_pyc",
  },
  {
    name: "a flattened devicetree",
    create: writeBytes("board.dtb", devicetreeBlob),
    format: "devicetree",
    operation: "inspect_devicetree",
  },
  {
    // An NVRAM variable store declares a file-system GUID REA does not walk.
    name: "a UEFI variable-store volume",
    create: writeBytes(
      "vars.fd",
      () =>
        buildFv({
          files: [],
          fileSystemGuid: "fff12b8d-7696-4c8b-a985-2747075b4f50",
        }).buffer,
    ),
    format: "uefi",
    operation: "inspect_uefi_firmware",
  },
  {
    name: "a SQLite database",
    create: async (directory: string) => {
      const fixture = createSqliteDatabaseFixture(directory);
      fixture.close();
      return fixture.path;
    },
    format: "sqlite",
    operation: "inspect_sqlite_database",
  },
  {
    name: "a Debian package",
    create: writeBytes("hello.deb", () => debPackageFixture()),
    format: "deb",
    operation: "inspect_deb_package",
  },
])(
  "inventories $name and routes it to $operation",
  async ({ create, format, operation }) => {
    const directory = await createTestTempDirectory("rea-standalone-format-");
    const path = await create(directory);

    expect(await inspect(path)).toEqual({
      format,
      subject: format,
      probes: [{ operation, authority: "artifact-bytes" }],
    });
  },
);

it("keeps bytes that only resemble a pyc frame unsupported", async () => {
  const directory = await createTestTempDirectory("rea-standalone-format-");
  const path = join(directory, "data.pyc");
  // CR LF framing with a magic no pinned CPython release uses.
  await writeFile(path, Buffer.from([0x01, 0x00, 0x0d, 0x0a, 0, 0, 0, 0]));

  await expect(
    runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  ).resolves.toMatchObject({ code: "target_unavailable" });
});

it("keeps a plain ar archive that is not a Debian package unsupported", async () => {
  const directory = await createTestTempDirectory("rea-standalone-format-");
  const path = join(directory, "libhello.a");
  await writeFile(
    path,
    arArchive([{ name: "hello.o", data: Buffer.from("object") }]),
  );

  await expect(
    runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  ).resolves.toMatchObject({ code: "target_unavailable" });
});

it("routes a bFLT executable's text segment to open_binary", async () => {
  const directory = await createTestTempDirectory("rea-standalone-format-");
  const path = await writeBytes("app.flt", () =>
    bfltFile({ text: Buffer.alloc(16), entry: 0x44 }),
  )(directory);
  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  );
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );

  expect(inspection.subject.root_format).toBe("bflt");
  expect(inspection.next_probes).toEqual([
    expect.objectContaining({
      operation: "open_binary",
      authority: "native-analysis-provider",
      rationale: expect.stringMatching(
        /text\.bin[\s\S]*raw-binary[\s\S]*0x44/u,
      ),
    }),
  ]);
  expect(inspection.next_probes[0]?.rationale).toContain("base_address");
  expect(inspection.next_probes[0]?.rationale).toMatch(
    /bFLT header, not code/u,
  );
});
