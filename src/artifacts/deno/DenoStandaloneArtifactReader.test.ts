import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { elfNote, elfNoteFixture } from "../../native/elf/ElfNotes.fixture.js";
import {
  MAX_INSPECT_ELF_NOTE_ENTRIES,
  MAX_INSPECT_ELF_NOTE_FILE_BYTES,
} from "../../domain/native/elfNotes.js";
import { MAX_INSPECT_PE_FILE_BYTES } from "../../domain/native/peResources.js";
import { peResourceFixture } from "../../native/pe/PeResources.fixture.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../../tests/fixtures/artifactInventory.js";
import { artifactFormatDescriptor } from "../artifactFormats.js";
import { ArtifactPathRegistry } from "../ArtifactPaths.js";
import { DenoStandaloneArtifactReader } from "../DenoStandaloneArtifactReader.js";
import { DENO_SECTION_MAGIC } from "./DenoSectionLayout.js";
import {
  locateDenoStandalone,
  MAX_DENO_INTEL_TRAILER_SENTINELS,
} from "./DenoStandaloneLocation.js";
import {
  buildDenoSection,
  defaultDenoMetadata,
  denoElf,
  denoIntelTrailer,
  denoMachO,
  denoPe,
  denoUniversal,
} from "./DenoStandalone.fixture.js";
import { MAX_DENO_PATH_COMPONENT_BYTES } from "./DenoVirtualFs.js";

const secret = "super-secret-value";

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const root = await createTestTempDirectory("rea-deno-reader-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return path;
};

const sectionFor = (
  contents: Buffer,
  vfs: unknown = [{ File: { n: "main.ts", o: [0, contents.length], u: true } }],
): Buffer =>
  buildDenoSection({
    metadata: {
      ...defaultDenoMetadata(),
      env_vars_from_env_file: { REA_DENO_TOKEN: secret },
      ca_data: [1, 2, 3, 4],
    },
    vfs,
    vfsFileData: contents,
    npmSnapshot: Buffer.from("npm-bytes"),
  });

const inventoryOf = (name: string, bytes: Buffer) =>
  writeCarrier(name, bytes).then((path) =>
    scanCanonicalArtifactInventory(path),
  );

it.each([
  [
    "mach-o",
    (section: Buffer) => denoMachO(section),
    "mach-o",
    "mach-o-section",
  ],
  ["elf", (section: Buffer) => denoElf(section), "elf", "elf-note"],
  ["pe", (section: Buffer) => denoPe([section]), "pe", "pe-resource"],
  [
    "intel-trailer",
    (section: Buffer) => denoIntelTrailer(section),
    "mach-o",
    "mach-o-intel-trailer",
  ],
  [
    "universal",
    (section: Buffer) => denoUniversal([denoMachO(section)]),
    "mach-o",
    "mach-o-section",
  ],
] as const)(
  "inventories a %s Deno compile carrier",
  async (_name, carrier, formatCarrier, embedding) => {
    const contents = Buffer.from("console.log('deno')\n");
    const snapshot = await inventoryOf("app", carrier(sectionFor(contents)));
    expect(snapshot.manifest.root_format).toBe("deno-standalone");
    const root = snapshot.occurrences.find((row) => row.logical_path === ".");
    expect(root?.format_metadata).toMatchObject({
      kind: "deno-standalone",
      carrier: formatCarrier,
      embedding,
      entrypoint_key: "main.ts",
      npm_snapshot_byte_length: "npm-bytes".length,
      env_var_count: 1,
      env_vars: [
        {
          name: "REA_DENO_TOKEN",
          value: secret,
          value_byte_length: secret.length,
        },
      ],
      ca_data: [1, 2, 3, 4],
      ca_data_byte_length: 4,
      vfs_listing: "listed",
    });
    expect(JSON.stringify(root?.format_metadata)).toContain(secret);
    expect(snapshot.limitations).toContain(
      artifactFormatDescriptor("deno-standalone")?.readerLimitation,
    );
    const member = snapshot.occurrences.find(
      (row) => row.logical_path === "main.ts",
    );
    expect(member).toMatchObject({
      artifact_format: "javascript-bundle",
      format_metadata: {
        kind: "deno-standalone-entry",
        role: "vfs-file",
        entry_point: true,
        source_path: "main.ts",
      },
    });
    expect(
      snapshot.nodes.find((node) => node.artifact_id === member?.artifact_id)
        ?.sha256,
    ).toBe(createHash("sha256").update(contents).digest("hex"));
  },
);

it("keeps child regions and both copies of a duplicated name", async () => {
  const original = Buffer.from("source\n");
  const transpiled = Buffer.from("transpiled\n");
  const cjs = Buffer.from("cjs\n");
  const map = Buffer.from("map\n");
  const data = Buffer.concat([
    original,
    transpiled,
    cjs,
    map,
    Buffer.from("b"),
  ]);
  const vfs = [
    {
      File: {
        n: "main.ts",
        o: [0, original.length],
        m: [original.length, transpiled.length],
        c: [original.length + transpiled.length, cjs.length],
        s: [original.length + transpiled.length + cjs.length, map.length],
        u: true,
      },
    },
    {
      File: {
        n: "main.ts",
        o: [data.length - 1, 1],
      },
    },
  ];
  const snapshot = await inventoryOf(
    "children",
    denoElf(sectionFor(data, vfs)),
  );
  const paths = snapshot.occurrences.map((row) => row.logical_path);
  expect(paths).toEqual(
    expect.arrayContaining([
      "main.ts",
      "main.ts.deno-transpiled",
      "main.ts.deno-cjs-analysis",
      "main.ts.deno-sourcemap",
    ]),
  );
  expect(paths.filter((path) => path === "main.ts")).toHaveLength(2);
  const region = snapshot.occurrences.find(
    (row) => row.logical_path === "main.ts.deno-transpiled",
  );
  expect(region?.format_metadata).toMatchObject({ role: "vfs-transpiled" });
  const file = snapshot.occurrences.find(
    (row) =>
      row.logical_path === "main.ts" &&
      row.format_metadata?.kind === "deno-standalone-entry" &&
      region?.format_metadata?.kind === "deno-standalone-entry" &&
      row.format_metadata.index === region.format_metadata.index,
  );
  expect(file?.format_metadata).toMatchObject({ role: "vfs-file" });
  expect(region?.parent_occurrence_id).not.toBe(file?.occurrence_id);
});

it("accepts identical duplicate sections and rejects differing ones", async () => {
  const section = buildDenoSection();
  const same = await inventoryOf("same", denoMachO([section, section]));
  expect(same.manifest.root_format).toBe("deno-standalone");
  const other = buildDenoSection({ vfsFileData: Buffer.from("other\n") });
  await expect(
    inventoryOf("different", denoMachO([section, other])),
  ).rejects.toMatchObject({ reason: "format" });
});

it("leaves an ELF note that is not a Deno section unclassified as deno", async () => {
  const bytes = elfNoteFixture({
    notes: elfNote("GNU", 1, Buffer.from("build-id")),
    ownership: "program",
    type: 1,
  });
  const snapshot = await inventoryOf("plain.elf", bytes);
  expect(snapshot.manifest.root_format).not.toBe("deno-standalone");
});

it("fails closed when a named section is truncated or lacks the opening marker", async () => {
  await expect(
    inventoryOf(
      "truncated",
      denoMachO(Buffer.concat([DENO_SECTION_MAGIC, Buffer.alloc(4)])),
    ),
  ).rejects.toMatchObject({ reason: "format" });
  await expect(
    inventoryOf("unmarked", denoMachO(Buffer.from("not-a-deno-section!!"))),
  ).rejects.toMatchObject({ reason: "unavailable" });
});

it("does not follow a symlink and refuses to open it", async () => {
  const contents = Buffer.from("target\n");
  const path = await writeCarrier(
    "links",
    denoElf(
      sectionFor(contents, [
        { File: { n: "main.ts", o: [0, contents.length], u: true } },
        { Symlink: { n: "alias", p: ["main.ts"] } },
      ]),
    ),
  );
  const reader = new DenoStandaloneArtifactReader(path);
  const entries = [];
  for await (const entry of reader.entries()) entries.push(entry);
  const link = entries.find((entry) => entry.kind === "symlink");
  expect(link).toMatchObject({
    path: "alias",
    formatMetadata: { symlink_dest_parts: ["main.ts"] },
  });
  await expect(reader.open(link!)).rejects.toMatchObject({ reason: "format" });
  await reader.close();
  await expect(
    reader.entries()[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ reason: "unavailable" });
});

it("reports cancellation and keeps indexed paths for an unsupported remote listing", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const path = await writeCarrier("cancel", denoElf());
  const reader = new DenoStandaloneArtifactReader(path);
  await expect(
    reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ reason: "cancelled" });
  await reader.close();

  const remote = await inventoryOf(
    "remote",
    denoElf(
      buildDenoSection({
        specifiers: [{ bytes: Buffer.from([0xff]), id: 4 }],
        remoteModules: [{ specifierId: 4, data: Buffer.from("body") }],
      }),
    ),
  );
  expect(
    remote.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    format_metadata: { remote_module_listing: "unsupported" },
  });
  const indexed = remote.occurrences.find(
    (row) => row.logical_path === "deno-remote/0",
  );
  expect(indexed).toMatchObject({
    limitations: expect.arrayContaining([
      expect.stringContaining("not available as a logical path"),
    ]),
  });
});

it("keeps a resolved remote module beside one with a missing specifier", async () => {
  const url = "https://example.com/mod.ts";
  const snapshot = await inventoryOf(
    "partial-remote",
    denoElf(
      buildDenoSection({
        metadata: { ...defaultDenoMetadata(), entrypoint_key: url },
        specifiers: [{ text: url, id: 1 }],
        remoteModules: [
          { specifierId: 1, data: "known" },
          { specifierId: 2, data: "missing" },
        ],
      }),
    ),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    format_metadata: { remote_module_listing: "unsupported" },
  });
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === "deno-remote/example.com/mod.ts",
    ),
  ).toMatchObject({
    format_metadata: { source_path: url, entry_point: true },
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "deno-remote/1"),
  ).toMatchObject({
    format_metadata: { source_path: null, entry_point: false },
    limitations: expect.arrayContaining([
      expect.stringContaining("not available as a logical path"),
    ]),
  });
});

it.each([
  ["a port", "http://localhost:8000/mod.ts", "localhost%3A8000/mod.ts"],
  ["an IPv6 host", "http://[::1]:8000/mod.ts", "[%3A%3A1]%3A8000/mod.ts"],
  ["a path colon", "https://example.com/a:b.ts", "example.com/a%3Ab.ts"],
])("encodes %s in a remote logical path", async (_label, url, path) => {
  const snapshot = await inventoryOf(
    "remote-colon",
    denoElf(
      buildDenoSection({
        specifiers: [{ text: url, id: 1 }],
        remoteModules: [{ specifierId: 1, data: "body", transpiled: "js" }],
      }),
    ),
  );
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === `deno-remote/${path}`,
    ),
  ).toMatchObject({ format_metadata: { source_path: url } });
  expect(snapshot.occurrences.map((row) => row.logical_path)).toContain(
    `deno-remote/${path}.deno-transpiled`,
  );
});

it("encodes a colon in a specifier that is not a host path", async () => {
  const snapshot = await inventoryOf(
    "remote-jsr",
    denoElf(
      buildDenoSection({
        specifiers: [{ text: "jsr:@std/path", id: 1 }],
        remoteModules: [{ specifierId: 1, data: "body" }],
      }),
    ),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "jsr%3A@std/path"),
  ).toMatchObject({ format_metadata: { source_path: "jsr:@std/path" } });
});

it("indexes a remote path that collides once its colon is encoded", async () => {
  const snapshot = await inventoryOf(
    "remote-encoded-collision",
    denoElf(
      buildDenoSection({
        specifiers: [
          { text: "https://example.com/a:b.ts", id: 1 },
          { text: "https://example.com/a%3Ab.ts", id: 2 },
        ],
        remoteModules: [
          { specifierId: 1, data: "first" },
          { specifierId: 2, data: "second" },
        ],
      }),
    ),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "deno-remote/1"),
  ).toMatchObject({
    format_metadata: { source_path: "https://example.com/a%3Ab.ts" },
  });
});

it.each([
  [
    "a colon",
    "https://example.com/a:b.ts",
    "https://example.com/a%3ab.ts",
    "deno-remote/example.com/a%3Ab.ts",
  ],
  [
    "a query",
    "https://example.com/a?b",
    "https://example.com/a%3fb",
    "deno-remote/example.com/a%3Fb",
  ],
  ["a backslash", "x:a\\b", "x%3aa%5cb", "x%3Aa%5Cb"],
])(
  "indexes a specifier whose escape differs from %s only in hex case",
  async (_label, first, second, path) => {
    const snapshot = await inventoryOf(
      "remote-escape-case",
      denoElf(
        buildDenoSection({
          specifiers: [
            { text: first, id: 1 },
            { text: second, id: 2 },
          ],
          remoteModules: [
            { specifierId: 1, data: "first" },
            { specifierId: 2, data: "second" },
          ],
        }),
      ),
    );
    expect(
      snapshot.occurrences.find((row) => row.logical_path === path),
    ).toMatchObject({ format_metadata: { source_path: first } });
    expect(
      snapshot.occurrences.find((row) => row.logical_path === "deno-remote/1"),
    ).toMatchObject({ format_metadata: { source_path: second } });
    expect(snapshot.limitations.join("\n")).not.toContain("case folding");
  },
);

it("reports unknown coverage when the virtual filesystem cannot be listed", async () => {
  const snapshot = await inventoryOf(
    "unlisted-vfs",
    denoElf(
      buildDenoSection({
        vfs: { unexpected: true },
        specifiers: [{ text: "https://example.com/mod.ts", id: 1 }],
        remoteModules: [{ specifierId: 1, data: "remote" }],
      }),
    ),
  );
  expect(snapshot.manifest.root_format).toBe("deno-standalone");
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({ format_metadata: { vfs_listing: "unsupported" } });
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("virtual filesystem could not be listed"),
    ]),
  );
});

it("indexes a remote specifier whose component exceeds the filesystem name limit", async () => {
  const query = `q=${"a".repeat(MAX_DENO_PATH_COMPONENT_BYTES)}`;
  const specifier = `https://example.com/mod.ts?${query}`;
  const snapshot = await inventoryOf(
    "long-remote",
    denoElf(
      buildDenoSection({
        specifiers: [
          { text: "file:///main.ts", id: 0 },
          { text: specifier, id: 1 },
        ],
        remoteModules: [{ specifierId: 1, data: Buffer.from("body") }],
      }),
    ),
  );
  expect(
    snapshot.occurrences.find(
      (row) =>
        row.format_metadata !== null &&
        typeof row.format_metadata === "object" &&
        "role" in row.format_metadata &&
        row.format_metadata.role === "remote-module",
    ),
  ).toMatchObject({
    logical_path: "deno-remote/0",
    format_metadata: { source_path: specifier },
    limitations: expect.arrayContaining([
      expect.stringContaining(`${String(MAX_DENO_PATH_COMPONENT_BYTES)}-byte`),
    ]),
  });
});

it.each([
  ["transpiled", { transpiled: "out" }],
  ["source map", { sourceMap: "{}" }],
  ["CJS export analysis", { cjs: "{}" }],
])(
  "indexes a remote module whose %s child path would exceed the name limit",
  async (_label, child) => {
    const leaf = `${"a".repeat(MAX_DENO_PATH_COMPONENT_BYTES - 3)}.ts`;
    const carrier = (extra: Record<string, string>) =>
      denoElf(
        buildDenoSection({
          specifiers: [
            { text: "file:///main.ts", id: 0 },
            { text: `https://example.com/${leaf}`, id: 1 },
          ],
          remoteModules: [
            { specifierId: 1, data: Buffer.from("body"), ...extra },
          ],
        }),
      );
    const paths = async (bytes: Buffer) =>
      (await inventoryOf("remote-child", bytes)).occurrences.map(
        (row) => row.logical_path,
      );
    expect(await paths(carrier({}))).toContain(
      `deno-remote/example.com/${leaf}`,
    );
    const indexed = await paths(carrier(child));
    expect(indexed).toContain("deno-remote/0");
    expect(indexed.some((path) => path.includes(leaf))).toBe(false);
  },
);

it("marks an entry point by its source path, not an indexed logical path", async () => {
  const contents = Buffer.from("x");
  const snapshot = await inventoryOf(
    "indexed-entry",
    denoElf(
      buildDenoSection({
        metadata: { ...defaultDenoMetadata(), entrypoint_key: "deno-vfs/0" },
        vfs: [{ File: { n: "..", o: [0, 1] } }],
        vfsFileData: contents,
      }),
    ),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "deno-vfs/0"),
  ).toMatchObject({ format_metadata: { entry_point: false } });
});

it("indexes a remote path that prefixes another embedded path", async () => {
  const snapshot = await inventoryOf(
    "remote-prefix",
    denoElf(
      buildDenoSection({
        specifiers: [
          { text: "file:///main.ts", id: 0 },
          { text: "https://example.com/a.ts", id: 1 },
        ],
        remoteModules: [{ specifierId: 1, data: Buffer.from("body") }],
        vfs: [
          {
            Dir: {
              n: "deno-remote",
              e: [
                {
                  Dir: {
                    n: "example.com",
                    e: [{ File: { n: "a.ts", o: [0, 1] } }],
                  },
                },
              ],
            },
          },
        ],
        vfsFileData: Buffer.from("x"),
      }),
    ),
  );
  expect(
    snapshot.occurrences.find(
      (row) =>
        row.format_metadata !== null &&
        typeof row.format_metadata === "object" &&
        "role" in row.format_metadata &&
        row.format_metadata.role === "remote-module",
    ),
  ).toMatchObject({
    logical_path: "deno-remote/0",
    limitations: expect.arrayContaining([expect.stringContaining("prefix")]),
  });
});

it("scans blocked remote namespaces once across all modules", async () => {
  const count = 1_000;
  const image = denoElf(
    buildDenoSection({
      specifiers: Array.from({ length: count }, (_, id) => ({
        id,
        text: `file:///deno-remote/module-${String(id)}.ts`,
      })),
      remoteModules: Array.from({ length: count }, (_, specifierId) => ({
        specifierId,
        data: Buffer.from("x"),
      })),
      vfs: Array.from({ length: count }, (_, index) => ({
        File: {
          n: index === 0 ? "deno-remote" : `deno-remote-${String(index)}`,
          o: [0, 1],
        },
      })),
      vfsFileData: Buffer.from("v"),
    }),
  );
  const path = await writeCarrier("blocked-namespaces", image);
  const reader = new DenoStandaloneArtifactReader(path);
  const conflicts = vi.spyOn(ArtifactPathRegistry.prototype, "conflicts");
  try {
    const paths: string[] = [];
    for await (const entry of reader.entries()) paths.push(entry.path);
    expect(paths).toContain(`deno-remote-${String(count)}/0`);
    expect(paths).toContain(
      `deno-remote-${String(count)}/${String(count - 1)}`,
    );
    expect(paths).toHaveLength(count * 2);
    expect(new Set(paths).size).toBe(paths.length);
    expect(conflicts.mock.calls.length).toBeLessThan(count * 4);
  } finally {
    conflicts.mockRestore();
    await reader.close();
  }
});

const bytesHandle = (
  image: Buffer,
  onRead?: (length: number) => void,
): FileHandle =>
  ({
    async read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      onRead?.(length);
      const start = position;
      const available =
        start >= image.length ? 0 : Math.min(length, image.length - start);
      if (available > 0) image.copy(buffer, offset, start, start + available);
      if (available < length)
        buffer.fill(0, offset + available, offset + length);
      return { bytesRead: length, buffer };
    },
  }) as FileHandle;

it("rejects unequal duplicate lengths without hashing payloads", async () => {
  const image = denoMachO([Buffer.alloc(4096), Buffer.alloc(4095)]);
  let payloadBytes = 0;
  const probe = await locateDenoStandalone(
    bytesHandle(image, (length) => {
      if (length >= 4095) payloadBytes += length;
    }),
    image.length,
  );
  expect(probe).toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
  expect(payloadBytes).toBe(0);
});

it("stops hashing duplicate sections at the first mismatch", async () => {
  const image = denoMachO([
    Buffer.alloc(4096),
    Buffer.alloc(4096, 1),
    Buffer.alloc(4096),
  ]);
  let payloadBytes = 0;
  const probe = await locateDenoStandalone(
    bytesHandle(image, (length) => {
      if (length === 4096) payloadBytes += length;
    }),
    image.length,
  );
  expect(probe).toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
  expect(payloadBytes).toBe(8192);
});

it("bounds aggregate hashing of overlapping duplicate sections by carrier size", async () => {
  const count = 100;
  const payloadLength = 4096;
  const payloadAt = 32 + 72 + count * 80;
  const image = Buffer.concat([
    denoMachO(Array.from({ length: count }, () => Buffer.alloc(0))),
    Buffer.alloc(payloadLength + count - 1),
  ]);
  image.writeBigUInt64LE(BigInt(image.length - payloadAt), 32 + 32);
  image.writeBigUInt64LE(BigInt(image.length - payloadAt), 32 + 48);
  for (let index = 0; index < count; index += 1) {
    const sectionAt = 32 + 72 + index * 80;
    image.writeBigUInt64LE(BigInt(payloadLength), sectionAt + 40);
    image.writeUInt32LE(payloadAt + index, sectionAt + 48);
  }
  let payloadBytes = 0;
  const probe = await locateDenoStandalone(
    bytesHandle(image, (length) => {
      if (length === payloadLength) payloadBytes += length;
    }),
    image.length,
  );
  expect(probe).toMatchObject({
    status: "present",
    failure: { reason: "limit" },
  });
  expect(payloadBytes).toBeGreaterThan(0);
  expect(payloadBytes).toBeLessThanOrEqual(image.length);
});

it("leaves an x64 Mach-O with a libsui sentinel and no d3n0l4nd marker absent", async () => {
  const image = denoMachO([], { architecture: "x64" });
  const claimed = Buffer.alloc(8);
  claimed.writeBigUInt64LE(8n);
  const bytes = Buffer.concat([
    image,
    Buffer.from("runtime-padding-before-sentinel"),
    Buffer.from("<~sui-data~>", "latin1"),
    Buffer.from([0xef, 0xbe, 0xad, 0xde]),
    claimed,
    Buffer.from("notd3n0!"),
    Buffer.from("tail"),
  ]);
  const probe = await locateDenoStandalone(bytesHandle(bytes), bytes.length);
  expect(probe).toEqual({ status: "absent" });
});

it("accepts an Intel trailer that opens with d3n0l4nd before trailing bytes", async () => {
  const section = buildDenoSection();
  const bytes = Buffer.concat([
    denoIntelTrailer(section),
    Buffer.alloc(128, 0xab),
  ]);
  const probe = await locateDenoStandalone(bytesHandle(bytes), bytes.length);
  expect(probe).toMatchObject({
    status: "present",
    location: {
      carrier: "mach-o",
      embedding: "mach-o-intel-trailer",
      length: section.length,
    },
  });
});

const ELF64_PHOFF = 32;
const ELF64_SHOFF = 40;
const ELF64_PHENTSIZE = 54;
const ELF64_PHNUM = 56;
const ELF64_SHENTSIZE = 58;
const ELF64_SHNUM = 60;

const gnuElf = (
  ownership: "program" | "section" | "both",
  notes = elfNote("GNU", 1, Buffer.from("build-id")),
): Buffer => elfNoteFixture({ notes, ownership, type: 1 });

const damagedNote = (): Buffer => {
  const note = Buffer.alloc(16);
  note.writeUInt32LE(100, 0);
  return note;
};

const crowdedNotes = (): Buffer => {
  const note = elfNote("GNU", 1, Buffer.from("x"));
  return Buffer.concat(
    Array.from({ length: MAX_INSPECT_ELF_NOTE_ENTRIES + 1 }, () => note),
  );
};

const patched = (bytes: Buffer, write: (image: Buffer) => void): Buffer => {
  const image = Buffer.from(bytes);
  write(image);
  return image;
};

/** A relocatable object can hold more section headers than a linked image. */
const sectionHeavyElf = (sections: number): Buffer => {
  const image = Buffer.alloc(64 + sections * 64);
  gnuElf("program").copy(image, 0, 0, 64);
  image.writeBigUInt64LE(0n, ELF64_PHOFF);
  image.writeUInt16LE(0, ELF64_PHNUM);
  image.writeBigUInt64LE(64n, ELF64_SHOFF);
  image.writeUInt16LE(64, ELF64_SHENTSIZE);
  image.writeUInt16LE(sections, ELF64_SHNUM);
  return image;
};

it.each([
  ["a note table that cannot be parsed", gnuElf("program", damagedNote())],
  ["more notes than the note ceiling", gnuElf("program", crowdedNotes())],
  [
    "an unreadable program header table",
    patched(gnuElf("program"), (image) => {
      image.writeBigUInt64LE(BigInt(image.length + 8), ELF64_PHOFF);
    }),
  ],
  [
    "an unreadable section header table",
    patched(gnuElf("section"), (image) => {
      image.writeBigUInt64LE(BigInt(image.length + 8), ELF64_SHOFF);
    }),
  ],
  [
    "extended program numbering",
    patched(gnuElf("program"), (image) => {
      image.writeUInt16LE(0xffff, ELF64_PHNUM);
    }),
  ],
  [
    "a non-canonical program header size",
    patched(gnuElf("program"), (image) => {
      image.writeUInt16LE(72, ELF64_PHENTSIZE);
    }),
  ],
  ["5,000 section headers", sectionHeavyElf(5_000)],
])("keeps native inventory for an ELF with %s", async (_label, bytes) => {
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toEqual({ status: "absent" });
  const snapshot = await inventoryOf("native.elf", bytes);
  expect(snapshot.manifest.root_format).not.toBe("deno-standalone");
});

it("keeps native inventory for a compressed note section", async () => {
  const bytes = gnuElf("section");
  const shoff = Number(bytes.readBigUInt64LE(ELF64_SHOFF));
  const note = shoff + 64;
  expect(bytes.readUInt32LE(note + 4)).toBe(7);
  bytes.writeBigUInt64LE(0x800n, note + 8);
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toEqual({ status: "absent" });
});

const suiNote = (section = buildDenoSection()): Buffer => {
  const nameLength = Buffer.alloc(2);
  nameLength.writeUInt16LE("d3n0l4nd".length);
  return elfNote(
    "SUI",
    0x53554901,
    Buffer.concat([nameLength, Buffer.from("d3n0l4nd", "latin1"), section]),
  );
};

it("fails closed when a confirmed SUI note shares a damaged table", async () => {
  const bytes = gnuElf("program", Buffer.concat([suiNote(), damagedNote()]));
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});

it("reaches a SUI section note past an unreadable program table", async () => {
  const bytes = patched(gnuElf("both", suiNote()), (image) => {
    image.writeBigUInt64LE(BigInt(image.length + 8), ELF64_PHOFF);
  });
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});

it("names a truncated descriptor on a SUI note as Deno's failure", async () => {
  const stub = Buffer.alloc(4);
  stub.writeUInt16LE("d3n0l4nd".length);
  const bytes = gnuElf("program", elfNote("SUI", 0x53554901, stub));
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});

it("locates a Deno ELF note in a file larger than 512 MiB without a full-file read", async () => {
  const image = denoElf();
  const probe = await locateDenoStandalone(
    bytesHandle(image, (length) => {
      if (length > 2 * 1024 * 1024)
        throw new Error(`read of ${String(length)} bytes exceeds 2 MiB`);
    }),
    MAX_INSPECT_ELF_NOTE_FILE_BYTES + 4096,
  );
  expect(probe).toMatchObject({
    status: "present",
    location: { carrier: "elf", embedding: "elf-note" },
  });
});

it("classifies repeated ELF note headers within the note ceiling's read budget", async () => {
  const count = 4096;
  const note = elfNote("GNU", 1, Buffer.from("x"));
  const headerSize = 64;
  const phent = 56;
  const phoff = headerSize;
  const noteOff = phoff + count * phent;
  const bytes = Buffer.alloc(noteOff + note.length);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes[6] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(BigInt(phoff), 32);
  bytes.writeUInt16LE(headerSize, 52);
  bytes.writeUInt16LE(phent, 54);
  bytes.writeUInt16LE(count, 56);
  bytes.writeUInt16LE(64, 58);
  for (let index = 0; index < count; index += 1) {
    const ph = phoff + index * phent;
    bytes.writeUInt32LE(4, ph);
    bytes.writeUInt32LE(4, ph + 4);
    bytes.writeBigUInt64LE(BigInt(noteOff), ph + 8);
    bytes.writeBigUInt64LE(BigInt(note.length), ph + 32);
    bytes.writeBigUInt64LE(BigInt(note.length), ph + 40);
    bytes.writeBigUInt64LE(4n, ph + 48);
  }
  note.copy(bytes, noteOff);
  let reads = 0;
  const probe = await locateDenoStandalone(
    bytesHandle(bytes, () => {
      reads += 1;
    }),
    bytes.length,
  );
  expect(probe).toEqual({ status: "absent" });
  expect(reads).toBeLessThan(16);
});

const rejectedIntelSentinels = (count: number): Buffer => {
  const sentinel = Buffer.concat([
    Buffer.from("<~sui-data~>", "latin1"),
    Buffer.from([0xef, 0xbe, 0xad, 0xde]),
    Buffer.alloc(8),
  ]);
  return Buffer.concat(Array.from({ length: count }, () => sentinel));
};

it("rejects packed Intel sentinels without rereading a chunk per sentinel", async () => {
  const packed = Buffer.concat([
    denoMachO([], { architecture: "x64" }),
    Buffer.alloc(32 * 1024),
    rejectedIntelSentinels(48),
  ]);
  let readBytes = 0;
  const probe = await locateDenoStandalone(
    bytesHandle(packed, (length) => {
      readBytes += length;
    }),
    packed.length,
  );
  expect(probe).toEqual({ status: "absent" });
  expect(readBytes).toBeLessThan(128 * 1024);
});

it("leaves an x64 Mach-O absent when sentinels pass the allowance", async () => {
  const packed = Buffer.concat([
    denoMachO([], { architecture: "x64" }),
    rejectedIntelSentinels(MAX_DENO_INTEL_TRAILER_SENTINELS + 1),
  ]);
  let readBytes = 0;
  const probe = await locateDenoStandalone(
    bytesHandle(packed, (length) => {
      readBytes += length;
    }),
    packed.length,
  );
  expect(probe).toEqual({ status: "absent" });
  expect(readBytes).toBeLessThan(32 * 1024);
});

it("keeps searching the same window after a rejected Intel sentinel", async () => {
  const section = buildDenoSection();
  const bytes = Buffer.concat([
    denoIntelTrailer(section),
    rejectedIntelSentinels(3),
  ]);
  const probe = await locateDenoStandalone(bytesHandle(bytes), bytes.length);
  expect(probe).toMatchObject({
    status: "present",
    location: {
      embedding: "mach-o-intel-trailer",
      length: section.length,
    },
  });
});

const intelApp = (entrypoint: string, contents: Buffer): Buffer =>
  buildDenoSection({
    metadata: { ...defaultDenoMetadata(), entrypoint_key: entrypoint },
    vfs: [{ File: { n: entrypoint, o: [0, contents.length], u: true } }],
    vfsFileData: contents,
  });

/** An outer app whose asset is an Intel Deno executable, past one search chunk. */
const nestedIntelApp = (): {
  readonly outer: Buffer;
  readonly asset: Buffer;
} => {
  const source = Buffer.from("console.log('outer')\n");
  const asset = denoIntelTrailer(
    intelApp("inner.ts", Buffer.from("console.log('inner')\n")),
  );
  const padding = Buffer.alloc(2 * 1024 * 1024);
  const outer = buildDenoSection({
    metadata: { ...defaultDenoMetadata(), entrypoint_key: "outer.ts" },
    vfs: [
      { File: { n: "outer.ts", o: [0, source.length], u: true } },
      {
        File: {
          n: "padding.bin",
          o: [source.length, padding.length],
          u: false,
        },
      },
      {
        File: {
          n: "inner-app",
          o: [source.length + padding.length, asset.length],
          u: false,
        },
      },
    ],
    vfsFileData: Buffer.concat([source, padding, asset]),
  });
  return { outer, asset };
};

it("reads the enclosing app of an Intel Deno executable embedded as an asset", async () => {
  const { outer, asset } = nestedIntelApp();
  const bytes = denoIntelTrailer(outer);
  const snapshot = await inventoryOf("nested", bytes);
  expect(snapshot.manifest.root_format).toBe("deno-standalone");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    embedding: "mach-o-intel-trailer",
    section_offset: bytes.length - outer.length,
    section_length: outer.length,
    entrypoint_key: "outer.ts",
  });
  const paths = snapshot.occurrences.map((row) => row.logical_path);
  expect(paths).toEqual(expect.arrayContaining(["outer.ts", "inner-app"]));
  expect(paths).not.toContain("inner.ts");
  const member = snapshot.occurrences.find(
    (row) => row.logical_path === "inner-app",
  );
  expect(
    snapshot.nodes.find((node) => node.artifact_id === member?.artifact_id)
      ?.sha256,
  ).toBe(createHash("sha256").update(asset).digest("hex"));
});

it("treats a nested Intel sentinel as asset data when its length overruns the app", async () => {
  const inner = intelApp("inner.ts", Buffer.from("inner\n"));
  const asset = denoIntelTrailer(inner);
  asset.writeBigUInt64LE(
    BigInt(inner.length + 64),
    asset.length - inner.length - 8,
  );
  const outer = buildDenoSection({
    vfs: [{ File: { n: "main.ts", o: [0, asset.length], u: false } }],
    vfsFileData: asset,
  });
  const bytes = Buffer.concat([denoIntelTrailer(outer), Buffer.alloc(128)]);
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    location: { length: outer.length },
  });
});

const intelTrailerRecord = (section: Buffer): Buffer => {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(section.length));
  return Buffer.concat([
    Buffer.from("<~sui-data~>", "latin1"),
    Buffer.from([0xef, 0xbe, 0xad, 0xde]),
    length,
    section,
  ]);
};

const sideBySideIntelTrailers = (second: Buffer): Buffer =>
  Buffer.concat([
    denoIntelTrailer(intelApp("main.ts", Buffer.from("first\n"))),
    intelTrailerRecord(second),
  ]);

it("fails closed on side-by-side Intel trailers with different bytes", async () => {
  const bytes = sideBySideIntelTrailers(
    intelApp("main.ts", Buffer.from("other\n")),
  );
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});

it("accepts side-by-side Intel trailers with identical bytes", async () => {
  const second = intelApp("main.ts", Buffer.from("first\n"));
  const bytes = sideBySideIntelTrailers(second);
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    location: {
      embedding: "mach-o-intel-trailer",
      length: second.length,
    },
  });
});

it("refuses a confirmed Intel trailer when the allowance ends the outer search", async () => {
  const bytes = Buffer.concat([
    denoMachO([], { architecture: "x64" }),
    rejectedIntelSentinels(MAX_DENO_INTEL_TRAILER_SENTINELS),
    intelTrailerRecord(buildDenoSection()),
  ]);
  await expect(
    locateDenoStandalone(bytesHandle(bytes), bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    failure: {
      reason: "limit",
      boundary: "capacity",
    },
  });
});

it("locates a small D3N0L4ND resource in a PE larger than 512 MiB", async () => {
  const section = buildDenoSection();
  const image = denoPe([section]);
  const fileSize = MAX_INSPECT_PE_FILE_BYTES + 4096;
  const probe = await locateDenoStandalone(
    bytesHandle(image, (length) => {
      if (length > 2 * 1024 * 1024)
        throw new Error(`read of ${String(length)} bytes exceeds 2 MiB`);
    }),
    fileSize,
  );
  expect(probe).toMatchObject({
    status: "present",
    location: {
      carrier: "pe",
      embedding: "pe-resource",
      length: section.length,
    },
  });
});

it("fails closed when a D3N0L4ND payload is not file-backed", async () => {
  const fixture = peResourceFixture(true, [
    { type: 10, name: "D3N0L4ND", language: 1, payload: Buffer.from("x") },
  ]);
  fixture.bytes.writeUInt32LE(0xffff_fff0, fixture.dataOffsets[0]!);
  await expect(
    locateDenoStandalone(bytesHandle(fixture.bytes), fixture.bytes.length),
  ).resolves.toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});
