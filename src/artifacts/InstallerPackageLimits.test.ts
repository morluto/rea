import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { ArtifactDecodedBudget } from "./ArtifactDecodedBudget.js";
import { CpioArtifactReader } from "./CpioArtifactReader.js";
import {
  MODE,
  gzipCpio,
  xarArchive,
  rewriteXarToc,
  type XarFixtureMember,
} from "./InstallerPackage.fixture.js";
import { XarArtifactReader } from "./XarArtifactReader.js";
import { visitArtifactTree } from "./ArtifactTraversal.js";

const withReader = async (
  bytes: Uint8Array,
  run: (reader: XarArtifactReader) => Promise<void>,
  decodedBudget?: ArtifactDecodedBudget,
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-pkg-limits-"));
  const path = join(root, "fixture.pkg");
  await writeFile(path, bytes);
  const reader = new XarArtifactReader(
    path,
    decodedBudget === undefined ? {} : { decodedBudget },
  );
  try {
    await run(reader);
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
};

it("shares an inflation budget across separate zlib members", async () => {
  const bytes = xarArchive([
    { name: "a", data: Buffer.alloc(40, 65), encoding: "zlib" },
    { name: "b", data: Buffer.alloc(40, 66), encoding: "zlib" },
  ]);
  await withReader(
    bytes,
    async (reader) => {
      let read = 0;
      await expect(
        (async () => {
          for await (const entry of reader.entries()) {
            await buffer(await reader.open(entry));
            read++;
          }
        })(),
      ).rejects.toMatchObject({
        reason: "limit",
        message: expect.stringContaining("Decoded archive budget"),
      });
      expect(read).toBe(1);
    },
    new ArtifactDecodedBudget(64),
  );
});

it("charges raw member reads to the same cumulative work budget", async () => {
  await withReader(
    xarArchive([
      { name: "a", data: Buffer.alloc(40, 65) },
      { name: "b", data: Buffer.alloc(40, 66) },
    ]),
    async (reader) => {
      let read = 0;
      await expect(
        (async () => {
          for await (const entry of reader.entries()) {
            await buffer(await reader.open(entry));
            read++;
          }
        })(),
      ).rejects.toMatchObject({
        reason: "limit",
        message: expect.stringContaining("Decoded archive budget"),
      });
      expect(read).toBe(1);
    },
    new ArtifactDecodedBudget(64),
  );
});

it("validates unsafe extents even when a member is unsupported and would not be opened", async () => {
  const bytes = rewriteXarToc(
    xarArchive([{ name: "a", encoding: "bzip2", data: Buffer.from("opaque") }]),
    (xml) =>
      xml.replace(
        /<offset>20<\/offset>/u,
        `<offset>${Number.MAX_SAFE_INTEGER}</offset>`,
      ),
  );
  await withReader(bytes, async (reader) => {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("heap extent"),
    });
  });
});

it.each(["", " ", "1e2", "0x10"])(
  "rejects nondecimal/empty numeric TOC data: %j",
  async (value) => {
    const bytes = rewriteXarToc(
      xarArchive([{ name: "a", data: Buffer.from("bytes") }]),
      (xml) =>
        xml.replace(/<length>\d+<\/length>/u, `<length>${value}</length>`),
    );
    await withReader(bytes, async (reader) => {
      await expect(
        (async () => {
          for await (const entry of reader.entries()) void entry;
        })(),
      ).rejects.toMatchObject({
        reason: "format",
        message: "xar TOC has an invalid data length",
      });
    });
  },
);

it("rejects unsafe absolute heap ranges with a tagged format failure", async () => {
  const bytes = rewriteXarToc(
    xarArchive([{ name: "Payload", data: Buffer.from("gzip") }]),
    (xml) =>
      xml.replace(
        /<offset>20<\/offset>/u,
        `<offset>${Number.MAX_SAFE_INTEGER}</offset>`,
      ),
  );
  await withReader(bytes, async (reader) => {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("heap extent"),
    });
  });
});

it("bounds retained full paths from deeply nested TOCs", async () => {
  let member: XarFixtureMember = { name: "leaf", data: Buffer.from("x") };
  for (let depth = 0; depth < 300; depth++)
    member = {
      name: "directory-segment",
      type: "directory",
      children: [member],
    };
  await withReader(xarArchive([member]), async (reader) => {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({
      reason: "limit",
      message: expect.stringContaining("path text"),
    });
  });
});

it("observes cancellation during internal symlink drains", async () => {
  const controller = new AbortController();
  const archive = gzipCpio([
    {
      name: "huge-link",
      mode: MODE.symlink,
      data: "x".repeat(4 * 1024 * 1024),
    },
  ]);
  let decoded = 0;
  const budget = new (class extends ArtifactDecodedBudget {
    override consume(bytes: number, path: string): void {
      super.consume(bytes, path);
      decoded += bytes;
      if (decoded >= 64 * 1024) controller.abort();
    }
  })();
  const reader = new CpioArtifactReader(
    async () => Readable.from([archive]),
    "fail",
    budget,
  );
  try {
    await expect(
      (async () => {
        for await (const entry of reader.entries(controller.signal)) void entry;
      })(),
    ).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
    await reader.close();
  }
});

it("verifies gzip integrity even when the cpio trailer has already been decoded", async () => {
  const bytes = Buffer.from(
    gzipCpio([{ name: "a", mode: MODE.file, data: "ok" }]),
  );
  bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 1;
  const reader = new CpioArtifactReader(async () => Readable.from([bytes]));
  try {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({ reason: "format" });
  } finally {
    await reader.close();
  }
});

it.each(["0755junk", "-1", "", "08"])(
  "rejects partially parsed or malformed mode %j",
  async (mode) => {
    await withReader(
      xarArchive([{ name: "a", mode, data: Buffer.from("x") }]),
      async (reader) => {
        await expect(
          (async () => {
            for await (const entry of reader.entries()) void entry;
          })(),
        ).rejects.toMatchObject({
          reason: "format",
          message: "xar TOC has an invalid mode",
        });
      },
    );
  },
);

it("preserves CRC contradictions for special nodes and reaches later siblings", async () => {
  const bytes = gzipCpio(
    [
      { name: "fifo", mode: MODE.fifo, data: "abc", check: 1 },
      { name: "good", mode: MODE.file, data: "ok" },
    ],
    "crc",
  );
  const reader = new CpioArtifactReader(
    async () => Readable.from([bytes]),
    "record-and-continue",
  );
  try {
    const paths: string[] = [];
    for await (const entry of reader.entries()) {
      paths.push(entry.path);
      if (entry.path === "fifo")
        expect(entry.limitations).toContain(
          "Declared decoded cpio-byte-sum 00000001 disagrees with observed 00000126.",
        );
      if (entry.path === "good")
        expect((await buffer(await reader.open(entry))).toString()).toBe("ok");
    }
    expect(paths).toEqual(["fifo", "good"]);
  } finally {
    await reader.close();
  }
});

it("does not expose a partial inventory when a previous TOC load failed", async () => {
  await withReader(
    xarArchive([{ name: "a", mode: "broken", data: Buffer.from("x") }]),
    async (reader) => {
      const scan = async () => {
        for await (const entry of reader.entries()) void entry;
      };
      await expect(scan()).rejects.toMatchObject({ reason: "format" });
      await expect(scan()).rejects.toMatchObject({ reason: "format" });
    },
  );
});

it("rejects a TOC whose element count would build an unbounded DOM", async () => {
  const noise = "<n/>".repeat(100_001);
  const bytes = rewriteXarToc(
    xarArchive([{ name: "a", data: Buffer.from("ok") }]),
    (xml) => xml.replace("<toc>", `<toc>${noise}`),
  );
  await withReader(bytes, async (reader) => {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({
      reason: "limit",
      message: "xar TOC exceeds 100000 XML elements",
    });
  });
});

it("rejects a TOC checksum when the fixed header declares none", async () => {
  const bytes = Buffer.from(
    xarArchive([{ name: "a", data: Buffer.from("ok") }]),
  );
  bytes.writeUInt32BE(0, 24);
  await withReader(bytes, async (reader) => {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("declares no TOC checksum"),
    });
  });
});

it.each(["", "nothex", "a".repeat(63)])(
  "rejects malformed checksum text %j before applying integrity policy",
  async (digest) => {
    const bytes = rewriteXarToc(
      xarArchive([{ name: "a", data: Buffer.from("ok") }]),
      (xml) =>
        xml.replace(
          /<extracted-checksum style="sha1">[^<]*<\/extracted-checksum>/u,
          `<extracted-checksum style="sha256">${digest}</extracted-checksum>`,
        ),
    );
    await withReader(bytes, async (reader) => {
      await expect(
        (async () => {
          for await (const entry of reader.entries()) void entry;
        })(),
      ).rejects.toMatchObject({
        reason: "format",
        message: "xar extracted-checksum has malformed sha256 digest text",
      });
    });
  },
);

it("rejects a CRC trailer whose declared checksum is not empty-data zero", async () => {
  const raw = gunzipSync(gzipCpio([], "crc"));
  raw.write("00000001", 102, "ascii");
  const reader = new CpioArtifactReader(async () =>
    Readable.from([gzipSync(raw)]),
  );
  try {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) void entry;
      })(),
    ).rejects.toMatchObject({
      reason: "integrity",
      message:
        "cpio CRC disagrees with content: TRAILER!!! (Declared decoded cpio-byte-sum 00000001 disagrees with observed 00000000.)",
    });
  } finally {
    await reader.close();
  }
});

it("bounds retained metadata independently of small decoded byte counts", async () => {
  const members = Array.from({ length: 100 }, (_, index) => ({
    name: `empty-${index}`,
    mode: MODE.file,
  }));
  const reader = new CpioArtifactReader(
    async () => Readable.from([gzipCpio(members)]),
    "fail",
    new ArtifactDecodedBudget(1024 * 1024, 32 * 1024),
  );
  let seen = 0;
  try {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) {
          void entry;
          seen++;
        }
      })(),
    ).rejects.toMatchObject({
      reason: "limit",
      message: expect.stringContaining("Retained archive metadata budget"),
    });
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(members.length);
  } finally {
    await reader.close();
  }
});

it("recovers directory CRC contradictions before yielding and reaches regular siblings", async () => {
  const reader = new CpioArtifactReader(
    async () =>
      Readable.from([
        gzipCpio(
          [
            { name: "dir", mode: MODE.directory, check: 1 },
            { name: "dir/good", mode: MODE.file, data: "ok" },
          ],
          "crc",
        ),
      ]),
    "record-and-continue",
  );
  try {
    const seen: string[] = [];
    for await (const entry of reader.entries()) {
      seen.push(entry.path);
      if (entry.kind === "directory")
        expect(entry.limitations).toContain(
          "Declared decoded cpio-byte-sum 00000001 disagrees with observed 00000000.",
        );
      else
        expect((await buffer(await reader.open(entry))).toString()).toBe("ok");
    }
    expect(seen).toEqual(["dir", "dir/good"]);
  } finally {
    await reader.close();
  }
});

it.each(["directory", "symlink"])(
  "rejects data declarations attached to non-file type %s",
  async (type) => {
    const bytes = rewriteXarToc(
      xarArchive([{ name: "a", data: Buffer.from("data") }]),
      (xml) => xml.replace("<type>file</type>", `<type>${type}</type>`),
    );
    await withReader(bytes, async (reader) => {
      await expect(
        (async () => {
          for await (const entry of reader.entries()) void entry;
        })(),
      ).rejects.toMatchObject({
        reason: "format",
        message: "xar non-file member declares data: a",
      });
    });
  },
);

it("charges long enclosing prefixes for every retained nested entry", async () => {
  const files = Array.from({ length: 100 }, (_, index) => ({
    name: `empty-${index}`,
    mode: MODE.file,
  }));
  let member: XarFixtureMember = { name: "Payload", data: gzipCpio(files) };
  for (let index = 0; index < 18; index++)
    member = { name: "d".repeat(200), type: "directory", children: [member] };
  await withReader(
    xarArchive([member]),
    async (reader) => {
      let retained = 0;
      await expect(
        visitArtifactTree(reader, async ({ container }) => {
          if (!container) retained++;
          return container;
        }),
      ).rejects.toMatchObject({
        reason: "limit",
        message: expect.stringContaining("Retained archive metadata budget"),
      });
      expect(retained).toBeLessThan(files.length + 18);
    },
    new ArtifactDecodedBudget(1024 * 1024, 512 * 1024),
  );
});
