import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { waitFor } from "../../../tests/support/testWait.js";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  inventoryArtifact,
  materializeArtifactInventory,
  scanArtifactInventory,
} from "../../../tests/fixtures/artifactInventory.js";
import { recognizeTarPrefix } from "../../domain/tarFormat.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
  ArtifactTraversalOmission,
} from "../../resources/index.js";
import { TarArtifactReader } from "./TarArtifactReader.js";
import { GzipTarStream } from "./TarByteStream.js";
import {
  gzipTarFixture,
  RELEASE_TAR_MEMBERS,
  tarFixture,
  tarHeader,
  tarMembers,
  type TarFixtureMember,
} from "./tar.fixture.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const write = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-tar-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

const read = async (bytes: Buffer, options: { expanded?: number } = {}) => {
  const reader = new TarArtifactReader(
    await write("archive.tar", bytes),
    undefined,
    options.expanded,
  );
  const coverage: ArtifactReaderTraversal[] = [];
  const omissions: ArtifactTraversalOmission[] = [];
  const entries: ArtifactEntry[] = [];
  const contents = new Map<string, string>();
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
      onOmission: (value) => omissions.push(value),
    }))
      entries.push(entry);
    for (const entry of entries)
      if (entry.kind === "file")
        contents.set(
          entry.path,
          (await collect(await reader.open(entry))).toString("utf8"),
        );
    return {
      entries,
      coverage,
      omissions,
      contents,
      metadata: reader.formatMetadata(),
    };
  } finally {
    await reader.close();
  }
};

describe("tar recognition", () => {
  it("claims ustar, GNU and gzip-wrapped tar but not plain gzip", () => {
    expect(recognizeTarPrefix(tarFixture(RELEASE_TAR_MEMBERS))).toBe("none");
    expect(
      recognizeTarPrefix(tarFixture([{ name: "a", dialect: "gnu" }])),
    ).toBe("none");
    expect(recognizeTarPrefix(gzipTarFixture(RELEASE_TAR_MEMBERS))).toBe(
      "gzip",
    );
    expect(recognizeTarPrefix(gzipSync(Buffer.alloc(2048, 7)))).toBeUndefined();
  });

  it("does not claim a header whose checksum is wrong", () => {
    const bytes = tarFixture([{ name: "a.txt", data: "a" }]);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(recognizeTarPrefix(bytes)).toBeUndefined();
  });
});

describe.each([
  ["stored", tarFixture, "none"],
  ["gzip", gzipTarFixture, "gzip"],
] as const)("%s tar inventory", (_name, build, compression) => {
  it("lists members with modes, links and complete coverage", async () => {
    const result = await read(build(RELEASE_TAR_MEMBERS));
    expect(
      result.entries.map(({ path, kind, executable, declaredSize }) => ({
        path,
        kind,
        executable,
        declaredSize,
      })),
    ).toEqual([
      {
        path: "app/",
        kind: "directory",
        executable: false,
        declaredSize: null,
      },
      {
        path: "app/run.x86_64",
        kind: "file",
        executable: true,
        declaredSize: 15,
      },
      {
        path: "app/data.pck",
        kind: "file",
        executable: false,
        declaredSize: 15,
      },
      {
        path: "app/latest",
        kind: "symlink",
        executable: false,
        declaredSize: null,
      },
    ]);
    expect(result.entries[3]?.formatMetadata).toMatchObject({
      kind: "tar-entry",
      typeflag: "2",
      mode: 0o777,
      link_name: "run.x86_64",
      uname: "builder",
    });
    expect(result.entries[1]?.sourcePath).toBe("./app/run.x86_64");
    expect(result.contents.get("app/data.pck")).toBe("GDPC-not-really");
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
    expect(result.metadata).toMatchObject({
      kind: "tar",
      compression,
      dialects: ["ustar"],
      member_count: 4,
      end_state: "end-marker",
      trailing_nonzero_bytes: 0,
    });
    // Stored members are carrier ranges; gzip offsets are not file bytes.
    expect(result.entries[1]?.byteOffset).toBe(
      compression === "none" ? 3 * 512 : null,
    );
  });

  it("applies pax paths, GNU long names and the ustar prefix", async () => {
    const long = `${"d/".repeat(80)}leaf.bin`;
    const members: TarFixtureMember[] = [
      { name: "ignored", data: "pax", pax: { path: "pax/ünïcode.txt" } },
      { name: "short", data: "prefixed", prefix: "deep/prefix" },
      {
        name: "././@LongLink",
        type: "L",
        data: `${long}\u0000`,
        dialect: "gnu",
      },
      { name: long.slice(0, 99), data: "gnu-long", dialect: "gnu" },
    ];
    const result = await read(build(members));
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "pax/ünïcode.txt",
      "deep/prefix/short",
      long,
    ]);
    expect(result.contents.get(long)).toBe("gnu-long");
    expect(result.metadata).toMatchObject({
      pax_headers: 1,
      dialects: ["gnu", "ustar"],
    });
  });

  it("reports devices, FIFOs and hard links as omissions, not members", async () => {
    const result = await read(
      build([
        { name: "a.txt", data: "a" },
        { name: "dev/null", type: "3" },
        { name: "pipe", type: "6" },
        { name: "b.txt", type: "1", linkname: "a.txt" },
      ]),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.omissions).toEqual([
      { path: "dev/null", kind: "character-device" },
      { path: "pipe", kind: "fifo" },
      { path: "b.txt", kind: "unsupported" },
    ]);
  });

  it("keeps members before a corrupt header and reports the stop as malformed", async () => {
    const good = tarMembers([{ name: "a.txt", data: "a" }]);
    const bad = tarHeader({ name: "b.txt" }, 1);
    bad[0] = (bad[0] ?? 0) ^ 1;
    const result = await read(
      compression === "gzip"
        ? gzipSync(Buffer.concat([good, bad, Buffer.alloc(1536)]))
        : Buffer.concat([good, bad, Buffer.alloc(1536)]),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(result.metadata).toMatchObject({
      end_state: "malformed",
      end_offset: 1024,
    });
  });

  it("reports non-zero bytes after the end marker as uninventoried", async () => {
    const body = Buffer.concat([
      tarMembers([{ name: "a.txt", data: "a" }]),
      Buffer.alloc(1024),
      Buffer.from("tail"),
    ]);
    const result = await read(compression === "gzip" ? gzipSync(body) : body);
    expect(result.coverage).toEqual([
      {
        status: "unknown",
        limitations: [
          "4 non-zero byte(s) follow the tar end-of-archive marker at offset 1024; they were not inventoried.",
        ],
      },
    ]);
  });
});

describe("truncated tar", () => {
  it("drops a stored member whose data the file does not hold", async () => {
    const bytes = tarFixture([
      { name: "a.txt", data: "a" },
      { name: "big.bin", data: "x".repeat(2000) },
    ]).subarray(0, 512 * 4);
    const result = await read(bytes);
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.metadata).toMatchObject({
      end_state: "truncated",
      end_offset: 1024,
    });
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("reports a cut gzip stream as truncated and keeps the complete members", async () => {
    const whole = gzipTarFixture([
      { name: "a.txt", data: "a" },
      {
        name: "noise.bin",
        data: createHash("sha512").update("seed").digest("hex").repeat(400),
      },
    ]);
    const result = await read(whole.subarray(0, whole.length - 200));
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.metadata?.end_state).toBe("truncated");
    expect(result.coverage[0]?.limitations[0]).toMatch(
      /^gzip stream ends before its end marker after \d+ decompressed byte\(s\); tar members after that point were not inventoried\.$/u,
    );
  });

  it("refuses a file whose first header is invalid as malformed tar", async () => {
    const bytes = tarFixture([{ name: "a.txt", data: "a" }]);
    bytes[148] = 0x39;
    await expect(read(bytes)).rejects.toMatchObject({
      reason: "malformed",
      parseFailure: { kind: "malformed", format: "tar", offset: 0 },
    });
  });
});

describe("gzip expansion", () => {
  it("charges decompressed bytes to the plaintext-work allowance", async () => {
    const bytes = gzipTarFixture([
      { name: "zeros.bin", data: Buffer.alloc(256 * 1024) },
    ]);
    await expect(read(bytes, { expanded: 64 * 1024 })).rejects.toMatchObject({
      reason: "limit",
      readerLimit: { parameter: "artifact_limits.expanded_bytes" },
    });
  });

  it("charges expansion as zlib produces it, so an idle reader cannot queue past the allowance", async () => {
    const path = await write(
      "zeros.tar.gz",
      gzipTarFixture([
        { name: "zeros.bin", data: Buffer.alloc(4 * 1024 * 1024) },
      ]),
    );
    const allowance = 64 * 1024;
    let charged = 0;
    let refused = false;
    const handle = await open(path, "r");
    const { size } = await handle.stat();
    const stream = new GzipTarStream(handle, size, (bytes) => {
      if (charged + bytes > allowance) {
        refused = true;
        throw new Error("allowance exhausted");
      }
      charged += bytes;
    });
    try {
      expect((await stream.read(1)).length).toBe(1);
      // Read nothing more; production alone must reach the allowance.
      await waitFor(() => expect(refused).toBe(true));
      expect(charged).toBeLessThanOrEqual(allowance);
      await expect(stream.skip(size * 2000)).rejects.toThrow(
        "allowance exhausted",
      );
      expect(stream.position).toBeLessThanOrEqual(allowance);
    } finally {
      stream.close();
      await handle.close();
    }
  });

  it("serves members opened out of archive order from a fresh decompression", async () => {
    const path = await write(
      "archive.tar.gz",
      gzipTarFixture([
        { name: "a.txt", data: "first" },
        { name: "b.txt", data: "second" },
      ]),
    );
    const reader = new TarArtifactReader(path);
    try {
      const entries: ArtifactEntry[] = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const second = await collect(await reader.open(entries[1]!));
      const first = await collect(await reader.open(entries[0]!));
      expect([first.toString(), second.toString()]).toEqual([
        "first",
        "second",
      ]);
    } finally {
      await reader.close();
    }
  });
});

describe("tar root inventory", () => {
  it("inventories a gzip tar root as a tar container with its members hashed", async () => {
    const path = await write(
      "release.tar.gz",
      gzipTarFixture(RELEASE_TAR_MEMBERS),
    );
    const graph = await inventoryArtifact(path);
    expect(graph.manifest.root_format).toBe("tar");
    expect(graph.coverage.status).toBe("complete");
    const data = graph.occurrences.find(
      (row) => row.logical_path === "app/data.pck",
    );
    expect(data).toMatchObject({
      hash_status: "verified",
      entry_kind: "file",
      format_metadata: { kind: "tar-entry", mode: 0o644 },
    });
  });
});

describe("tar extraction", () => {
  it("materializes gzip tar members under a fresh output root", async () => {
    const path = await write(
      "release.tar.gz",
      gzipTarFixture(RELEASE_TAR_MEMBERS),
    );
    const snapshot = await scanArtifactInventory(path);
    const result = await materializeArtifactInventory(
      {
        inputPath: path,
        inputFormat: "tar",
        outputRoot: join(dirname(path), "out"),
        environment: process.env,
        integrityPolicy: "fail",
      },
      path,
      snapshot,
    );
    expect(result.containment_verified).toBe(true);
    expect(
      await readFile(join(result.output_root, "app/data.pck"), "utf8"),
    ).toBe("GDPC-not-really");
  });
});

/** Rewrite a header's checksum after editing its fields. */
const rechecksum = (block: Buffer): Buffer => {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "latin1");
  return block;
};

const end = Buffer.alloc(1024);

describe("tar header edge cases", () => {
  it("skips an old GNU sparse member's map extension blocks and keeps later members", async () => {
    const sparse = tarHeader(
      { name: "holes.bin", type: "S", dialect: "gnu" },
      512,
    );
    sparse[482] = 1;
    const extension = Buffer.alloc(512);
    extension[504] = 0;
    const result = await read(
      Buffer.concat([
        rechecksum(sparse),
        extension,
        Buffer.alloc(512, 0x73),
        tarMembers([{ name: "after.txt", data: "after" }]),
        end,
      ]),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["after.txt"]);
    expect(result.omissions).toEqual([
      { path: "holes.bin", kind: "unsupported" },
    ]);
    expect(result.metadata?.end_state).toBe("end-marker");
  });

  it("decodes a non-UTF-8 name byte for byte as Latin-1", async () => {
    const header = tarHeader({ name: "x" }, 1);
    header[0] = 0x80;
    const result = await read(
      Buffer.concat([rechecksum(header), Buffer.alloc(512, 0x61), end]),
    );
    expect(result.entries[0]?.path).toBe("\u0080");
    expect(result.entries[0]?.limitations).toEqual([
      "tar name is not UTF-8; decoded as Latin-1; raw hex: 80.",
    ]);
  });

  it("raises cancellation from a gzip read that is waiting for output", async () => {
    // A descriptor whose reads never complete keeps the inflater waiting.
    const handle = { read: () => new Promise<never>(() => undefined) };
    const stream = new GzipTarStream(handle, 1024, () => undefined);
    const controller = new AbortController();
    try {
      const pending = stream.read(1, controller.signal);
      controller.abort(new Error("caller cancelled"));
      await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    } finally {
      stream.close();
    }
  });

  it("stops as malformed at a pax size that is not a number, keeping earlier members", async () => {
    const pax = Buffer.from("12 size=abc\n");
    const result = await read(
      Buffer.concat([
        tarMembers([{ name: "a.txt", data: "a" }]),
        tarHeader({ name: "PaxHeader", type: "x" }, pax.length),
        pax,
        Buffer.alloc(512 - pax.length),
        tarMembers([{ name: "b.txt", data: "b" }]),
        end,
      ]),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.metadata).toMatchObject({
      end_state: "malformed",
      end_offset: 2048,
    });
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("recognizes a gzip tar whose header carries a comment longer than the probe bound", async () => {
    const tar = tarFixture([{ name: "a.txt", data: "a" }]);
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(crc32(tar), 0);
    trailer.writeUInt32LE(tar.length, 4);
    const bytes = Buffer.concat([
      // FLG.FCOMMENT (0x10), then a 3 KiB NUL-terminated comment.
      Buffer.from([0x1f, 0x8b, 0x08, 0x10, 0, 0, 0, 0, 0, 3]),
      Buffer.alloc(3072, 0x63),
      Buffer.alloc(1),
      deflateRawSync(tar),
      trailer,
    ]);
    expect(recognizeTarPrefix(bytes.subarray(0, 8192))).toBe("gzip");
    const result = await read(bytes);
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.coverage[0]?.status).toBe("complete");
  });

  it("keeps a pre-1970 GNU base-256 modification time", async () => {
    const header = tarHeader({ name: "old.txt", dialect: "gnu" }, 1);
    header.fill(0xff, 136, 148);
    const result = await read(
      Buffer.concat([rechecksum(header), Buffer.alloc(512, 0x61), end]),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["old.txt"]);
    expect(result.entries[0]?.formatMetadata).toMatchObject({ mtime: -1 });
  });

  it("does not apply a pending pax size to a GNU long-name header", async () => {
    const pax = Buffer.from("12 size=513\n");
    const long = `${"n".repeat(120)}\u0000`;
    const bytes = Buffer.concat([
      tarHeader({ name: "PaxHeader", type: "x" }, pax.length),
      pax,
      Buffer.alloc(512 - pax.length),
      tarHeader(
        { name: "././@LongLink", type: "L", dialect: "gnu" },
        long.length,
      ),
      Buffer.from(long),
      Buffer.alloc(512 - long.length),
      tarHeader({ name: "short", dialect: "gnu" }, 1),
      Buffer.alloc(1024, 0x62),
      end,
    ]);
    const result = await read(bytes);
    expect(
      result.entries.map((entry) => [entry.path, entry.declaredSize]),
    ).toEqual([["n".repeat(120), 513]]);
  });

  it("returns to header owner names when a global pax record clears them", async () => {
    const global = (body: string) => {
      const records = Buffer.from(body);
      return Buffer.concat([
        tarHeader({ name: "GlobalHead", type: "g" }, records.length),
        records,
        Buffer.alloc(512 - records.length),
      ]);
    };
    const result = await read(
      Buffer.concat([
        global("15 uname=alice\n"),
        tarMembers([{ name: "a.txt", data: "a" }]),
        global("9 uname=\n"),
        tarMembers([{ name: "b.txt", data: "b" }]),
        end,
      ]),
    );
    expect(
      result.entries.map((entry) => [
        entry.path,
        (entry.formatMetadata as { uname: string }).uname,
      ]),
    ).toEqual([
      ["a.txt", "alice"],
      ["b.txt", "builder"],
    ]);
  });

  it("treats a cut-off zero block as truncation, not an end marker", async () => {
    const result = await read(
      Buffer.concat([
        tarMembers([{ name: "a.txt", data: "a" }]),
        Buffer.alloc(1),
      ]),
    );
    expect(result.metadata).toMatchObject({ end_state: "truncated" });
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("keeps earlier members when a later header declares an unsafe size", async () => {
    const big = tarHeader({ name: "huge.bin", dialect: "gnu" }, 0);
    big.fill(0, 124, 136);
    big[124] = 0x80;
    big.fill(0xff, 125, 136);
    const result = await read(
      Buffer.concat([
        tarMembers([{ name: "a.txt", data: "a" }]),
        rechecksum(big),
        end,
      ]),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.metadata).toMatchObject({
      end_state: "malformed",
      end_offset: 1024,
    });
  });

  it("recognizes a small gzip tar whose trailer is damaged and keeps its complete member", async () => {
    const bytes = gzipSync(
      Buffer.concat([
        tarMembers([{ name: "a.txt", data: "a" }]).subarray(0, 600),
      ]),
    );
    // Corrupt the CRC32: the stream's data is intact, its trailer is not.
    bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 0xff;
    expect(recognizeTarPrefix(bytes)).toBe("gzip");
    const result = await read(bytes);
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.contents.get("a.txt")).toBe("a");
    expect(result.metadata?.end_state).toBe("malformed");
  });
});
