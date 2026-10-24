import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { NodeSeaArtifactReader } from "./NodeSeaArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import {
  NODE_SEA_BAD_MAGIC,
  NODE_SEA_DUPLICATE_BLOB,
  NODE_SEA_FUSE_CONFLICT,
  NODE_SEA_FUSE_ABSENT,
  NODE_SEA_FUSE_UNSET,
  NODE_SEA_MAGIC,
  NODE_SEA_TRUNCATED,
  NODE_SEA_UNKNOWN_FLAGS,
} from "./nodeSea/NodeSeaBlob.js";
import {
  NODE_SEA_FUSE_HASH,
  buildNodeSeaBlob,
  nodeSeaElf,
  nodeSeaMachO,
  nodeSeaPe,
  nodeSeaUniversal,
} from "./nodeSea/NodeSea.fixture.js";
import { elfNoteFixture } from "../native/elf/ElfNotes.fixture.js";
import { peResourceFixture } from "../native/pe/PeResources.fixture.js";
import { locateNodeSea } from "./nodeSea/NodeSeaLocation.js";
import { MAX_INSPECT_PE_FILE_BYTES } from "../domain/native/peResources.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-node-sea-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

const script = 'console.log("rea-node-sea")\n';
const populated = {
  codePath: "app/main.js",
  main: script,
  codeCache: Buffer.from("cache"),
  assets: [{ name: "assets/message.txt", body: "hello" }],
  execArgv: ["--no-warnings"],
  disableExperimentalSeaWarning: true,
  fuse: "set" as const,
};

it.each([
  ["mach-o", nodeSeaMachO(populated)],
  ["elf", nodeSeaElf(populated)],
  ["pe", nodeSeaPe(populated)],
] as const)("inventories a %s Node SEA carrier", async (carrier, bytes) => {
  const path = await writeCarrier(`sea-${carrier}`, bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("node-sea");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations).toContain(
    "Node SEA inventory establishes the injected blob, flags, fuse sentinel, main script, optional code cache, snapshot, and assets. V8 snapshots and code cache are not deserialized, and the application is not executed.",
  );
  expect(snapshot.limitations).not.toContain(NODE_SEA_FUSE_UNSET);
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({ artifact_kind: "container" });
  expect(root?.format_metadata).toMatchObject({
    kind: "node-sea",
    magic: NODE_SEA_MAGIC,
    carrier,
    code_path: "app/main.js",
    disable_experimental_sea_warning: true,
    use_snapshot: false,
    use_code_cache: true,
    include_assets: true,
    include_exec_argv: true,
    exec_argv: ["--no-warnings"],
    exec_argv_extension: "env",
    fuse_state: "set",
    fuse_sentinel: `NODE_SEA_FUSE_${NODE_SEA_FUSE_HASH}:1`,
    fuse_contradiction: null,
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "app/main.js"),
  ).toMatchObject({
    artifact_kind: "javascript",
    artifact_format: "javascript-bundle",
    format_metadata: { kind: "node-sea-entry", role: "main-script" },
  });
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === "__node_sea__/code-cache",
    ),
  ).toMatchObject({
    artifact_format: "file",
    format_metadata: { role: "code-cache" },
  });
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === "assets/message.txt",
    ),
  ).toMatchObject({ format_metadata: { role: "asset" } });
  const scriptNode = snapshot.nodes.find(
    (node) => node.size === Buffer.byteLength(script),
  );
  expect(scriptNode).toBeDefined();
});

it("accepts the __NODE_SEA segment spelling and a universal Mach-O slice", async () => {
  const underscored = await scanCanonicalArtifactInventory(
    await writeCarrier(
      "underscored",
      nodeSeaMachO({ ...populated, segmentName: "__NODE_SEA" }),
    ),
  );
  expect(underscored.manifest.root_format).toBe("node-sea");
  const universal = await scanCanonicalArtifactInventory(
    await writeCarrier("universal", nodeSeaUniversal(populated)),
  );
  expect(universal.manifest.root_format).toBe("node-sea");
  expect(
    universal.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({ carrier: "mach-o", fuse_state: "set" });
});

it("reads a 32-bit and a big-endian Mach-O section", async () => {
  for (const bytes of [
    nodeSeaMachO({ ...populated, bits: 32 }),
    nodeSeaMachO({ ...populated, littleEndian: false }),
  ]) {
    const snapshot = await scanCanonicalArtifactInventory(
      await writeCarrier("macho-variant", bytes),
    );
    expect(snapshot.manifest.root_format).toBe("node-sea");
    expect(
      snapshot.occurrences.find((row) => row.logical_path === "app/main.js"),
    ).toMatchObject({ artifact_format: "javascript-bundle" });
  }
});

it("classifies a main script without a JavaScript suffix as javascript-bundle", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier(
      "plain-name",
      nodeSeaElf({ codePath: "main", main: script, fuse: "set" }),
    ),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "main"),
  ).toMatchObject({
    artifact_kind: "javascript",
    artifact_format: "javascript-bundle",
  });
});

it("keeps a snapshot body opaque and retains the code path", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier(
      "snapshot",
      nodeSeaElf({
        codePath: "sea.js",
        snapshot: Buffer.from("snap-bytes"),
        fuse: "set",
      }),
    ),
  );
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    use_snapshot: true,
    code_path: "sea.js",
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "sea.js"),
  ).toBeUndefined();
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === "__node_sea__/snapshot",
    ),
  ).toMatchObject({
    artifact_format: "file",
    format_metadata: { role: "snapshot" },
  });
});

it.each([
  ["absent", undefined, "absent", null],
  ["unset", "unset", "unset", `NODE_SEA_FUSE_${NODE_SEA_FUSE_HASH}:0`],
] as const)(
  "reports a %s fuse as a contradiction",
  async (_label, fuse, state, sentinel) => {
    const reason =
      state === "absent" ? NODE_SEA_FUSE_ABSENT : NODE_SEA_FUSE_UNSET;
    const snapshot = await scanCanonicalArtifactInventory(
      await writeCarrier(
        "fuse",
        nodeSeaElf({ ...(fuse === undefined ? {} : { fuse }), main: script }),
      ),
    );
    expect(
      snapshot.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      fuse_state: state,
      fuse_sentinel: sentinel,
      fuse_contradiction: reason,
    });
    expect(snapshot.limitations).toContain(reason);
    expect(snapshot.coverage.status).toBe("complete");
  },
);

it("reports disagreeing fuse sentinels", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("conflict", nodeSeaPe({ fuse: "conflicting" })),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    fuse_state: "conflicting",
    fuse_sentinel: null,
    fuse_contradiction: NODE_SEA_FUSE_CONFLICT,
  });
  expect(snapshot.limitations).toContain(NODE_SEA_FUSE_CONFLICT);
});

it("leaves a Mach-O, ELF, or PE without a SEA slot in its native format", async () => {
  const mach = await scanCanonicalArtifactInventory(
    await writeCarrier(
      "plain-macho",
      nodeSeaMachO({
        segmentName: "__TEXT",
        sectionName: "__text",
        blob: Buffer.from("text"),
      }),
    ),
  );
  expect(mach.manifest.root_format).toBe("mach-o");
  const elf = await scanCanonicalArtifactInventory(
    await writeCarrier("plain-elf", elfNoteFixture({ type: 2 })),
  );
  expect(elf.manifest.root_format).toBe("elf");
  const pe = await scanCanonicalArtifactInventory(
    await writeCarrier("plain-pe", peResourceFixture(true).bytes),
  );
  expect(pe.manifest.root_format).toBe("pe");
});

it.each([false, true])(
  "scopes the large PE admission limit to SEA resources (PE32+: %s)",
  async (plus) => {
    for (const sea of [false, true]) {
      const bytes = peResourceFixture(plus, [
        {
          type: sea ? 10 : 11,
          name: "NODE_SEA_BLOB",
          language: 1033,
          payload: buildNodeSeaBlob(populated),
        },
        {
          type: 10,
          name: "OTHER_RESOURCE",
          language: 1033,
          payload: Buffer.from("other"),
        },
      ]).bytes;
      const path = await writeCarrier("large-pe", bytes);
      const handle = await open(path, "r+");
      try {
        if (!sea)
          await expect(
            locateNodeSea(handle, bytes.length),
          ).resolves.toBeUndefined();
        await handle.truncate(MAX_INSPECT_PE_FILE_BYTES + 1);
        const located = locateNodeSea(handle, MAX_INSPECT_PE_FILE_BYTES + 1);
        if (sea)
          await expect(located).rejects.toMatchObject({
            reason: "limit",
            message:
              "Node SEA PE inspection exceeds the 512 MiB PE parser input ceiling",
          });
        else await expect(located).resolves.toBeUndefined();
      } finally {
        await handle.close();
      }
    }
  },
);

it("trusts the PT_NOTE blob over a stale SHT_NOTE entry", async () => {
  const bytes = nodeSeaElf({ ...populated, ownership: "both" });
  // ELF64: the note section header follows one 56-byte program header.
  const noteOffsetField = 64 + 56 + 64 + 24;
  const noteOffset = bytes.readBigUInt64LE(noteOffsetField);
  bytes.writeBigUInt64LE(noteOffset + 20n, noteOffsetField);
  const inventory = await scanCanonicalArtifactInventory(
    await writeCarrier("stale-section-note", bytes),
  );
  expect(inventory.manifest.root_format).toBe("node-sea");
});

it("leaves a non-SEA PE with a cyclic resource tree to native classification", async () => {
  const fixture = peResourceFixture(true);
  fixture.bytes.writeUInt32LE(0x80000000, (fixture.entryOffsets[0] ?? 0) + 4);
  const path = await writeCarrier("cyclic-pe", fixture.bytes);
  const handle = await open(path, "r");
  try {
    await expect(
      locateNodeSea(handle, fixture.bytes.length),
    ).resolves.toBeUndefined();
  } finally {
    await handle.close();
  }
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.manifest.root_format).not.toBe("node-sea");
});

it("fails closed when the located blob is truncated, has a bad magic, or unknown flags", async () => {
  await expect(
    scanCanonicalArtifactInventory(
      await writeCarrier(
        "truncated",
        nodeSeaElf({ blob: Buffer.from([0x20, 0xda, 0x43]) }),
      ),
    ),
  ).rejects.toMatchObject({ reason: "format", message: NODE_SEA_TRUNCATED });
  await expect(
    scanCanonicalArtifactInventory(
      await writeCarrier("bad-magic", nodeSeaMachO({ blob: Buffer.alloc(16) })),
    ),
  ).rejects.toMatchObject({ reason: "format", message: NODE_SEA_BAD_MAGIC });
  const unknown = Buffer.alloc(9);
  unknown.writeUInt32LE(NODE_SEA_MAGIC, 0);
  unknown.writeUInt32LE(1 << 5, 4);
  unknown[8] = 1;
  await expect(
    scanCanonicalArtifactInventory(
      await writeCarrier("unknown-flags", nodeSeaPe({ blob: unknown })),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: NODE_SEA_UNKNOWN_FLAGS,
  });
});

it("fails closed when two different blobs are declared", async () => {
  await expect(
    scanCanonicalArtifactInventory(
      await writeCarrier(
        "dup-elf",
        nodeSeaElf({
          extraBlobs: [buildNodeSeaBlob({ main: "other\n" })],
        }),
      ),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: NODE_SEA_DUPLICATE_BLOB,
  });
  await expect(
    scanCanonicalArtifactInventory(
      await writeCarrier(
        "dup-macho",
        nodeSeaMachO({
          extraBlobs: [buildNodeSeaBlob({ codePath: "other.js", main: "x" })],
        }),
      ),
    ),
  ).rejects.toMatchObject({ message: NODE_SEA_DUPLICATE_BLOB });
});

it("keeps one blob when the same bytes are declared twice", async () => {
  const blob = buildNodeSeaBlob({ main: script, codePath: "sea.js" });
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier(
      "same",
      nodeSeaElf({ blob, extraBlobs: [blob], fuse: "set" }),
    ),
  );
  expect(snapshot.manifest.root_format).toBe("node-sea");
  expect(
    snapshot.occurrences.filter((row) => row.logical_path === "sea.js"),
  ).toHaveLength(1);
});

it("extracts the main script and assets without executing them", async () => {
  const directory = await createTestTempDirectory("rea-node-sea-extract-");
  const path = join(directory, "sea.elf");
  await writeFile(path, nodeSeaElf(populated));
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      await readFile(join(extracted.output_root, "app/main.js"), "utf8"),
    ).toBe(script);
    expect(
      await readFile(join(extracted.output_root, "assets/message.txt"), "utf8"),
    ).toBe("hello");
    expect(
      await readFile(join(extracted.output_root, "__node_sea__/code-cache")),
    ).toEqual(Buffer.from("cache"));
    const extractedInventory = await scanCanonicalArtifactInventory(
      extracted.output_root,
    );
    expect(extractedInventory.manifest.root_format).toBe("directory");
    expect(
      extractedInventory.occurrences.find(
        (row) => row.logical_path === "app/main.js",
      )?.artifact_format,
    ).toBe("javascript-bundle");
  } finally {
    await resourceScope.close();
  }
});

it.each([
  { name: "traversal", codePath: "../main.js", assets: [] },
  {
    name: "duplicate asset",
    codePath: "main.js",
    assets: [
      { name: "data.txt", body: "a" },
      { name: "data.txt", body: "b" },
    ],
  },
  {
    name: "normalized collision",
    codePath: "main.js",
    assets: [
      { name: "a/café.txt", body: "a" },
      { name: "a/cafe\u0301.txt", body: "b" },
    ],
  },
  {
    name: "reserved script",
    codePath: "main.js",
    assets: [{ name: "main.js", body: "asset" }],
  },
])(
  "rejects $name before inventory can claim readable contents",
  async ({ codePath, assets }) => {
    const path = await writeCarrier("unsafe", nodeSeaElf({ codePath, assets }));
    await expect(scanCanonicalArtifactInventory(path)).rejects.toThrow();
  },
);

it("retains source asset spelling separately from normalized graph paths", async () => {
  const path = await writeCarrier(
    "source-path",
    nodeSeaElf({ assets: [{ name: "data/cafe\u0301.txt", body: "asset" }] }),
  );
  const graph = await scanCanonicalArtifactInventory(path);
  expect(
    graph.occurrences.find((row) => row.logical_path === "data/café.txt")
      ?.format_metadata,
  ).toMatchObject({ role: "asset", source_path: "data/cafe\u0301.txt" });
});

it("rejects missing Mach-O load commands after a confirmed SEA section", async () => {
  const bytes = nodeSeaMachO();
  bytes.writeUInt32LE(2, 16);
  await expect(
    scanCanonicalArtifactInventory(await writeCarrier("commands", bytes)),
  ).rejects.toMatchObject({
    reason: "format",
    message: "Node SEA Mach-O load commands are truncated",
  });
});

it("rejects forged entries and changed carrier identity, then closes idempotently", async () => {
  const path = await writeCarrier("identity", nodeSeaElf());
  const reader = new NodeSeaArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry === undefined) throw new Error("Missing main script");
    await expect(
      reader.open({ ...entry, byteOffset: 0 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await writeFile(path, nodeSeaElf({ main: "changed bytes" }));
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
    await reader.close();
  }
});

it("settles an active member stream when closed", async () => {
  const path = await writeCarrier(
    "close",
    nodeSeaElf({ main: Buffer.alloc(1024 * 1024, 65) }),
  );
  const reader = new NodeSeaArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry === undefined) throw new Error("Missing main script");
    const stream = await reader.open(entry);
    await reader.close();
    expect(stream.destroyed).toBe(true);
  } finally {
    await reader.close();
  }
});

it("honors cancellation before admitting a carrier", async () => {
  const path = await writeCarrier("cancel", nodeSeaElf());
  const reader = new NodeSeaArtifactReader(path);
  const controller = new AbortController();
  controller.abort("test cancellation");
  try {
    await expect(
      reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
    await reader.close();
  }
});
