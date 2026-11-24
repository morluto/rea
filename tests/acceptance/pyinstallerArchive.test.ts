import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import {
  PYTHON_39_MAGIC,
  cArchiveExecutable,
  cArchiveBytecodeExecutable,
  pyzArchive,
} from "../../src/artifacts/pyinstaller/CArchive.fixture.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { expectCarrierProbes } from "../fixtures/nativeCarrierProbes.js";
import { cliTest } from "../support/cli/cliFixture.js";

const onefile = async (
  magic = PYTHON_39_MAGIC,
  marker = false,
  compressPyz = false,
  pyzToc?: Buffer,
): Promise<string> => {
  const directory = await createTestTempDirectory("rea-pyinstaller-cli-");
  const path = join(directory, "hello");
  await writeFile(
    path,
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 314,
      pythonLibrary: "libpython3.14.dylib",
      trailer: Buffer.from("signature"),
      members: [
        ...(marker
          ? [
              {
                name: "pyimod00_crypto_key",
                typeCode: "m",
                payload: Buffer.from("key"),
                compress: false,
              },
            ]
          : []),
        {
          name: "pyi-contents-directory _internal",
          typeCode: "o",
          payload: Buffer.alloc(0),
          compress: false,
        },
        {
          name: "../shared/app:assets/data.bin",
          typeCode: "d",
          payload: Buffer.alloc(0),
          compress: false,
        },
        {
          name: "hello",
          typeCode: "s",
          payload: Buffer.from("print('hi')"),
          compress: true,
        },
        {
          name: "healthy.txt",
          typeCode: "x",
          payload: Buffer.from("healthy sibling"),
          compress: false,
        },
        {
          name: "PYZ.pyz",
          typeCode: "z",
          payload: pyzArchive({
            magic,
            modules: [
              { name: "app", typeCode: 0, body: Buffer.from("app-body") },
              {
                name: Buffer.concat([
                  Buffer.from("node_"),
                  Buffer.from("edb3bf", "hex"),
                ]),
                typeCode: 3,
                body: Buffer.alloc(0),
              },
            ],
            ...(pyzToc === undefined ? {} : { toc: pyzToc }),
          }),
          compress: compressPyz,
        },
      ],
    }),
  );
  return path;
};

const int32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
};

const marshalInt = (value: number): Buffer =>
  Buffer.concat([Buffer.from([0x69]), int32(value)]);

const marshalLong = (digits: readonly number[]): Buffer =>
  Buffer.concat([
    Buffer.from([0x6c]),
    int32(digits.length),
    ...digits.map((digit) => {
      const bytes = Buffer.alloc(2);
      bytes.writeUInt16LE(digit);
      return bytes;
    }),
  ]);

const namespaceToc = (typeCode: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([0x5b]),
    int32(1),
    Buffer.from([0x29, 2, 0x7a, 3]),
    Buffer.from("pkg"),
    Buffer.from([0x29, 3]),
    typeCode,
    marshalInt(12),
    marshalInt(0),
  ]);

const namespacePathCollision = async (): Promise<string> => {
  const directory = await createTestTempDirectory("rea-pyinstaller-namespace-");
  const path = join(directory, "collision");
  await writeFile(
    path,
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 309,
      members: [
        {
          name: "PYZ.pyz",
          typeCode: "z",
          payload: pyzArchive({
            magic: PYTHON_39_MAGIC,
            modules: [{ name: "ns", typeCode: 3, body: Buffer.alloc(0) }],
          }),
          compress: false,
        },
        {
          name: "PYZ.pyz/ns",
          typeCode: "x",
          payload: Buffer.from("outer data"),
          compress: false,
        },
        {
          name: "healthy.txt",
          typeCode: "x",
          payload: Buffer.from("healthy sibling"),
          compress: false,
        },
      ],
    }),
  );
  return path;
};

cliTest(
  "inventories CArchive declarations and extracts only verified files",
  async ({ cli: driver }) => {
    const path = await onefile();
    const result = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment: process.env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    expect(inspection.subject.root_format).toBe("pyinstaller");
    // The archive has no package reader; its ELF carrier keeps its readers.
    expectCarrierProbes(inspection.next_probes, "elf");
    const inventory = inspection.substeps[0]?.evidence.normalized_result;
    expect(inventory?.manifest.root_format).toBe("pyinstaller");
    const root = inventory?.occurrences.find(
      (occurrence) => occurrence.logical_path === ".",
    );
    expect(root?.format_metadata).toMatchObject({
      kind: "pyinstaller",
      python_version_raw: 314,
      python_major: 3,
      python_minor: 14,
      runtime_option_count: 1,
      external_dependency_count: 1,
    });
    expect(
      inventory?.occurrences.find(
        (item) =>
          item.entry_kind === "metadata" &&
          item.format_metadata?.kind === "pyinstaller-entry" &&
          item.format_metadata.type_code === "o",
      ),
    ).toMatchObject({
      artifact_id: null,
      source_path: "pyi-contents-directory _internal",
      format_metadata: {
        source_name: "pyi-contents-directory _internal",
        type_code: "o",
      },
    });
    expect(
      inventory?.occurrences.map((occurrence) => occurrence.logical_path),
    ).toEqual(expect.arrayContaining(["hello", "PYZ.pyz", "PYZ.pyz/app.pyc"]));
    expect(
      inventory?.occurrences.find(
        (row) =>
          row.format_metadata?.kind === "pyinstaller-entry" &&
          row.format_metadata.type_code === "d",
      ),
    ).toMatchObject({
      entry_kind: "metadata",
      artifact_id: null,
      format_metadata: {
        dependency_archive: "../shared/app",
        dependency_member: "assets/data.bin",
        dependency_status: "unresolved",
      },
    });
    expect(inventory?.coverage.status).toBe("complete");
    const pyz = inventory?.occurrences.find(
      ({ logical_path }) => logical_path === "PYZ.pyz",
    );
    expect(pyz?.format_metadata).toMatchObject({
      pyz_status: "decoded",
      pyz_python_magic: "610d0d0a",
      pyz_python_version: "3.9",
    });
    expect(
      inventory?.occurrences.find(
        ({ logical_path }) => logical_path === "PYZ.pyz/node_\udcff",
      ),
    ).toMatchObject({
      entry_kind: "metadata",
      artifact_id: null,
      source_path: "node_\udcff",
      format_metadata: { source_name: "node_\udcff", type_code: 3 },
    });

    const output = join(dirname(path), "extracted");
    const extraction = await driver.run({
      arguments: ["extract-artifact", path, "--output-root", output, "--json"],
    });
    expect(extraction.exitCode, extraction.stderr).toBe(0);
    const extracted = artifactExtractionResultSchema.parse(
      parseEvidence(extraction.json).normalized_result,
    );
    expect(extracted.output_root).toBe(output);
    expect(extracted.coverage).toEqual({
      scope: "container-entries",
      status: "complete",
    });
    expect(extracted.limitations).toContainEqual(
      expect.stringMatching(
        /^PYZ\.pyz\/app\.pyc:.*header.*reconstructed.*archive.*magic.*digest.*derived file/iu,
      ),
    );
    const expected = new Map([
      [
        "PYZ.pyz/app.pyc",
        Buffer.concat([
          Buffer.from("610d0d0a000000000000000000000000", "hex"),
          Buffer.from("app-body"),
        ]),
      ],
      ["healthy.txt", Buffer.from("healthy sibling")],
      ["hello", Buffer.from("print('hi')")],
    ]);
    expect(
      extracted.artifacts.map(({ relative_path }) => relative_path).sort(),
    ).toEqual([...expected.keys()]);
    for (const [name, bytes] of expected) {
      expect(
        extracted.artifacts.find(({ relative_path }) => relative_path === name),
      ).toMatchObject({
        bytes_written: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect((await readFile(join(output, name))).equals(bytes)).toBe(true);
    }
    expect((await readdir(output)).sort()).toEqual([
      "PYZ.pyz",
      "healthy.txt",
      "hello",
    ]);
    expect(await readdir(join(output, "PYZ.pyz"))).toEqual(["app.pyc"]);
  },
);

cliTest(
  "recognizes a distant PE signature and preserves Windows PyInstaller source names",
  async ({ cli: driver }) => {
    const directory = await createTestTempDirectory(
      "rea-pyinstaller-windows-names-",
    );
    const path = join(directory, "windows.exe");
    const storedName = String.raw`pkg\data.bin`;
    const dataKey = String.raw`res\icon.bin`;
    const stored = Buffer.from("stored bytes");
    const icon = Buffer.from("icon bytes");
    const module = Buffer.from("module bytes");
    await writeFile(
      path,
      cArchiveExecutable({
        carrier: "pe",
        peHeaderOffset: 8_190,
        layout: "2.1",
        pythonVersion: 309,
        members: [
          { name: storedName, typeCode: "x", payload: stored, compress: false },
          {
            name: "PYZ.pyz",
            typeCode: "z",
            payload: pyzArchive({
              magic: PYTHON_39_MAGIC,
              modules: [
                { name: dataKey, typeCode: 2, body: icon },
                { name: "pkg.mod", typeCode: 0, body: module },
              ],
            }),
            compress: false,
          },
        ],
      }),
    );
    const inspected = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    expect(inspection.subject.root_format).toBe("pyinstaller");
    const inventory = inspection.substeps[0]?.evidence.normalized_result;
    expect(inventory?.manifest.root_format).toBe("pyinstaller");
    expect(inventory?.coverage.status).toBe("complete");
    const rows = inventory?.occurrences;
    expect(
      rows?.find((row) => row.logical_path === "pkg/data.bin"),
    ).toMatchObject({
      hash_status: "verified",
      source_path: storedName,
      format_metadata: { source_name: storedName },
    });
    expect(
      rows?.find((row) => row.logical_path === "PYZ.pyz/res/icon.bin"),
    ).toMatchObject({
      hash_status: "verified",
      source_path: dataKey,
      format_metadata: { container_name: "PYZ.pyz", source_name: dataKey },
    });
    expect(
      rows?.find((row) => row.logical_path === "PYZ.pyz/pkg/mod.pyc"),
    ).toMatchObject({
      hash_status: "verified",
      source_path: "pkg.mod",
      format_metadata: { container_name: "PYZ.pyz", source_name: "pkg.mod" },
    });
    const output = join(directory, "extracted");
    const extracted = await driver.run({
      arguments: ["extract-artifact", path, "--output-root", output, "--json"],
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.output_root).toBe(output);
    const expectedPyc = Buffer.concat([
      Buffer.from("610d0d0a000000000000000000000000", "hex"),
      module,
    ]);
    for (const [name, bytes] of [
      ["pkg/data.bin", stored],
      ["PYZ.pyz/res/icon.bin", icon],
      ["PYZ.pyz/pkg/mod.pyc", expectedPyc],
    ] as const) {
      expect((await readFile(join(output, name))).equals(bytes), name).toBe(
        true,
      );
      expect(
        result.artifacts.find(({ relative_path }) => relative_path === name),
      ).toMatchObject({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes_written: bytes.length,
      });
    }
  },
);

cliTest(
  "extracts legacy and modern CArchive modules with one pyc header through the CLI",
  async ({ cli: driver }) => {
    const fixture = cArchiveBytecodeExecutable();
    const directory = await createTestTempDirectory(
      "rea-pyinstaller-bytecode-",
    );
    const path = join(directory, "bytecode-layouts");
    await writeFile(path, fixture.archive);
    const result = await driver.run({
      arguments: ["extract-artifact", path, "--json"],
      environment: process.env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const extraction = artifactExtractionResultSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    try {
      for (const module of fixture.modules) {
        expect(
          Buffer.compare(
            await readFile(join(extraction.output_root, module.name)),
            module.bytes,
          ),
        ).toBe(0);
        expect(
          extraction.artifacts.find(
            (item) => item.relative_path === module.name,
          ),
        ).toMatchObject({
          sha256: createHash("sha256").update(module.bytes).digest("hex"),
        });
      }
    } finally {
      await rm(extraction.output_root, { recursive: true, force: true });
    }
  },
);

cliTest(
  "preserves a PYZ namespace declaration beside a physical CArchive file at the same path",
  async ({ cli: driver }) => {
    const path = await namespacePathCollision();
    const inspectResult = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment: process.env,
    });
    expect(inspectResult.exitCode, inspectResult.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(JSON.parse(inspectResult.stdout)).normalized_result,
    );
    const inventory = inspection.substeps[0]?.evidence.normalized_result;
    expect(inventory?.coverage.status).toBe("complete");
    const namespace = inventory?.occurrences.find(
      (row) =>
        row.logical_path === "PYZ.pyz/ns" &&
        row.format_metadata?.kind === "pyinstaller-entry" &&
        row.format_metadata.type_code === 3,
    );
    const data = inventory?.occurrences.find(
      (row) =>
        row.logical_path === "PYZ.pyz/ns" &&
        row.entry_kind === "file" &&
        row.format_metadata?.kind === "pyinstaller-entry" &&
        row.format_metadata.type_code === "x",
    );
    expect(namespace).toMatchObject({
      entry_kind: "metadata",
      artifact_id: null,
      format_metadata: {
        container: "pyz",
        container_name: "PYZ.pyz",
        index: 0,
        source_name: "ns",
        type_code: 3,
      },
    });
    expect(data).toMatchObject({
      entry_kind: "file",
      hash_status: "verified",
      format_metadata: {
        container: "carchive",
        index: 1,
        source_name: "PYZ.pyz/ns",
        type_code: "x",
      },
    });
    expect(namespace?.occurrence_id).not.toBe(data?.occurrence_id);
    const dataNode = inventory?.nodes.find(
      (node) => node.artifact_id === data?.artifact_id,
    );
    expect(dataNode).toMatchObject({
      sha256: createHash("sha256").update("outer data").digest("hex"),
      size: Buffer.byteLength("outer data"),
    });
    const sibling = inventory?.occurrences.find(
      (row) => row.logical_path === "healthy.txt",
    );
    expect(sibling).toMatchObject({
      hash_status: "verified",
      format_metadata: {
        container: "carchive",
        index: 2,
        source_name: "healthy.txt",
        type_code: "x",
      },
    });
    expect(
      inventory?.nodes.find(
        (node) => node.artifact_id === sibling?.artifact_id,
      ),
    ).toMatchObject({
      sha256: createHash("sha256").update("healthy sibling").digest("hex"),
      size: Buffer.byteLength("healthy sibling"),
    });

    const extractResult = await driver.run({
      arguments: ["extract-artifact", path, "--json"],
      environment: process.env,
    });
    expect(extractResult.exitCode, extractResult.stderr).toBe(0);
    const extracted = artifactExtractionResultSchema.parse(
      parseEvidence(JSON.parse(extractResult.stdout)).normalized_result,
    );
    try {
      expect(extracted.artifacts.map((item) => item.relative_path)).toEqual(
        expect.arrayContaining(["PYZ.pyz/ns", "healthy.txt"]),
      );
      expect(
        Buffer.compare(
          await readFile(join(extracted.output_root, "PYZ.pyz", "ns")),
          Buffer.from("outer data"),
        ),
      ).toBe(0);
      expect(
        Buffer.compare(
          await readFile(join(extracted.output_root, "healthy.txt")),
          Buffer.from("healthy sibling"),
        ),
      ).toBe(0);
    } finally {
      await rm(extracted.output_root, { recursive: true, force: true });
    }
  },
);

cliTest(
  "reports unknown traversal through the CLI for an opaque PYZ",
  async ({ cli: driver }) => {
    const path = await onefile(Buffer.alloc(4), true, true);
    const result = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment: process.env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    const inventory = inspection.substeps[0]?.evidence.normalized_result;
    expect(inventory?.coverage.status).toBe("unknown");
    expect(inventory?.limitations.join(" ")).toContain("opaque");
    const opaque = inventory?.occurrences.find(
      (row) => row.logical_path === "PYZ.pyz",
    );
    expect(opaque).toMatchObject({
      encrypted: false,
      hash_status: "verified",
      artifact_id: expect.any(String),
      source_location: null,
    });
    expect(opaque?.format_metadata).toMatchObject({
      pyz_python_magic: "00000000",
      pyz_status: "opaque",
      encryption_source: "carchive-marker",
      compression_flag: 1,
    });
  },
);

cliTest.for([
  ["normalized long", marshalLong([3]), true],
  ["unnormalized long", marshalLong([3, 0]), false],
] as const)(
  "keeps PYZ namespace projection consistent with CPython for %s type codes",
  async ([_encoding, typeCode, decoded], { cli: driver }) => {
    const path = await onefile(
      PYTHON_39_MAGIC,
      false,
      false,
      namespaceToc(typeCode),
    );
    const result = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment: process.env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    const inventory = inspection.substeps[0]?.evidence.normalized_result;
    const pyz = inventory?.occurrences.find(
      (row) => row.logical_path === "PYZ.pyz",
    );
    const healthySibling = inventory?.occurrences.find(
      (row) => row.logical_path === "healthy.txt",
    );
    expect(healthySibling).toMatchObject({ hash_status: "verified" });
    expect(
      inventory?.nodes.find(
        (node) => node.artifact_id === healthySibling?.artifact_id,
      ),
    ).toMatchObject({
      sha256: createHash("sha256")
        .update(Buffer.from("healthy sibling"))
        .digest("hex"),
      size: Buffer.byteLength("healthy sibling"),
    });
    if (decoded) {
      expect(inventory?.coverage.status).toBe("complete");
      expect(pyz?.format_metadata).toMatchObject({ pyz_status: "decoded" });
      expect(
        inventory?.occurrences.find(
          (row) => row.logical_path === "PYZ.pyz/pkg",
        ),
      ).toMatchObject({
        entry_kind: "metadata",
        artifact_id: null,
        source_path: "pkg",
        format_metadata: { source_name: "pkg", type_code: 3 },
      });
    } else {
      expect(inventory?.coverage.status).toBe("unknown");
      expect(pyz?.format_metadata).toMatchObject({ pyz_status: "opaque" });
      expect(
        inventory?.occurrences.some(
          (row) => row.logical_path === "PYZ.pyz/pkg",
        ),
      ).toBe(false);
      expect(pyz?.limitations.join(" ")).toContain("long is not normalized");
    }
  },
);

cliTest(
  "keeps verified CArchive siblings when the PYZ marshal string body is truncated",
  async ({ cli: driver }) => {
    const path = await onefile(
      PYTHON_39_MAGIC,
      false,
      false,
      Buffer.from("5b010000007301000000", "hex"),
    );
    const result = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment: process.env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    const inventory = inspection.substeps[0]?.evidence.normalized_result;
    expect(inventory?.coverage.status).toBe("unknown");
    expect(inventory?.occurrences.map((item) => item.logical_path)).toEqual(
      expect.arrayContaining(["hello", "healthy.txt", "PYZ.pyz"]),
    );
    const healthySibling = inventory?.occurrences.find(
      (item) => item.logical_path === "healthy.txt",
    );
    expect(healthySibling).toMatchObject({
      hash_status: "verified",
      artifact_id: expect.any(String),
    });
    expect(
      inventory?.nodes.find(
        (node) => node.artifact_id === healthySibling?.artifact_id,
      ),
    ).toMatchObject({
      sha256: createHash("sha256")
        .update(Buffer.from("healthy sibling"))
        .digest("hex"),
      size: Buffer.byteLength("healthy sibling"),
    });
    const opaque = inventory?.occurrences.find(
      (item) => item.logical_path === "PYZ.pyz",
    );
    expect(opaque).toMatchObject({
      hash_status: "verified",
      format_metadata: { pyz_status: "opaque" },
    });
    expect(opaque?.limitations).toContainEqual(
      expect.stringContaining("PYZ marshal value is truncated"),
    );
    expect(
      inventory?.occurrences.some(
        ({ logical_path }) => logical_path === "PYZ.pyz/app.pyc",
      ),
    ).toBe(false);
  },
);

cliTest(
  "keeps positive over-budget PYZ sizes as resource refusals",
  async ({ cli: driver }) => {
    const path = await onefile(
      PYTHON_39_MAGIC,
      false,
      false,
      Buffer.from("7301000100", "hex"),
    );
    const result = await driver.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment: process.env,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "truncated",
      details: {
        reason: "limit",
        detail: expect.stringContaining(
          "PYZ marshal string exceeds the supported length",
        ),
      },
    });
  },
);
