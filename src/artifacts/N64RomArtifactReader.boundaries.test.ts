import { open } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import { n64RomImage } from "../domain/n64Rom.fixture.js";
import {
  N64_HEADER_BYTES,
  N64_IPL3_END,
  N64_IPL3_OFFSET,
  N64_MAX_ROM_BYTES,
} from "../domain/n64Rom.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/index.js";
import { N64RomArtifactReader } from "./N64RomArtifactReader.js";

const read = async (bytes: Buffer, expandedBytes?: number) => {
  const reader = new N64RomArtifactReader(
    await createTestTempFile("rea-n64-boundary-", "game.z64", bytes),
    undefined,
    expandedBytes,
  );
  const coverage: ArtifactReaderTraversal[] = [];
  const entries: ArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    const contents = new Map<string, Buffer>();
    for (const entry of entries)
      contents.set(entry.path, await buffer(await reader.open(entry)));
    return {
      entries,
      contents,
      coverage: coverage[0],
      metadata: reader.formatMetadata(),
    };
  } finally {
    await reader.close();
  }
};

describe("Nintendo 64 ROM boundaries", () => {
  it("refuses a header cut short as truncated", async () => {
    await expect(
      read(n64RomImage().encoded.subarray(0, 32)),
    ).rejects.toMatchObject({
      reason: "truncated",
      parseFailure: { kind: "truncated", format: "n64-rom", field: "header" },
    });
  });

  it("refuses a length its byte order cannot normalize", async () => {
    for (const [order, extra] of [
      ["v64", 1],
      ["n64", 2],
    ] as const) {
      const odd = Buffer.concat([
        n64RomImage({ order }).encoded,
        Buffer.alloc(extra),
      ]);
      await expect(read(odd)).rejects.toMatchObject({
        reason: "malformed",
        parseFailure: {
          kind: "malformed",
          format: "n64-rom",
          field: "byte_order",
        },
      });
      expect(
        await parseBinaryTarget(
          await createTestTempFile("rea-n64-odd-", `odd.${order}`, odd),
        ),
      ).toMatchObject({
        ok: false,
        error: { constraint: "file_format_rejected" },
      });
    }
  });

  it("reads a z64 image of any length, since it needs no swap", async () => {
    const image = n64RomImage();
    const odd = Buffer.concat([image.encoded, Buffer.from([0x5a])]);
    const result = await read(odd);
    expect(result.metadata?.rom_bytes).toBe(odd.length);
    expect(result.contents.get("program.z64")?.equals(odd)).toBe(true);
  });

  it("reads a v64 image whose length is even but not a multiple of 4", async () => {
    const image = n64RomImage({ order: "v64" });
    const odd = Buffer.concat([image.encoded, Buffer.from([0x11, 0x22])]);
    const result = await read(odd);
    expect(result.metadata?.source_order).toBe("v64");
    expect(
      result.contents
        .get("program.z64")
        ?.equals(Buffer.concat([image.normalized, Buffer.from([0x22, 0x11])])),
    ).toBe(true);
  });

  it("refuses an implausible boot address", async () => {
    for (const bootAddress of [0, 0x1000]) {
      await expect(
        read(n64RomImage({ bootAddress }).encoded),
      ).rejects.toMatchObject({
        reason: "malformed",
        parseFailure: {
          kind: "malformed",
          format: "n64-rom",
          field: "boot_address",
        },
      });
    }
  });

  it("refuses a header whose first word is not an N64 magic", async () => {
    await expect(read(Buffer.alloc(N64_HEADER_BYTES))).rejects.toMatchObject({
      reason: "malformed",
      parseFailure: {
        kind: "malformed",
        format: "n64-rom",
        field: "pi_dom1_config",
      },
    });
  });

  it("refuses a file above 64 MiB before reading its body", async () => {
    const directory = await createTestTempDirectory("rea-n64-ceiling-");
    const path = join(directory, "big.z64");
    const handle = await open(path, "w");
    try {
      await handle.write(n64RomImage().encoded.subarray(0, N64_HEADER_BYTES));
      await handle.truncate(N64_MAX_ROM_BYTES + 4);
    } finally {
      await handle.close();
    }
    expect(await parseBinaryTarget(path)).toMatchObject({
      ok: true,
      value: { kind: "archive", format: "n64-rom" },
    });
    const reader = new N64RomArtifactReader(path);
    try {
      await expect(async () => {
        for await (const entry of reader.entries()) void entry;
      }).rejects.toMatchObject({
        reason: "limit",
        boundary: "file-size",
        fixedAllowance: {
          name: "The Nintendo 64 ROM size allowance",
          kind: "bytes",
          limit: N64_MAX_ROM_BYTES,
          unit: "bytes",
        },
      });
    } finally {
      await reader.close();
    }
  });

  it("charges a decoded copy of each member against artifact_limits.expanded_bytes", async () => {
    const image = n64RomImage({ order: "v64" });
    const declared =
      (N64_HEADER_BYTES +
        (N64_IPL3_END - N64_IPL3_OFFSET) +
        image.encoded.length) *
      2;
    const path = await createTestTempFile(
      "rea-n64-budget-",
      "game.v64",
      image.encoded,
    );
    const reader = new N64RomArtifactReader(path, undefined, 16);
    try {
      await expect(async () => {
        for await (const entry of reader.entries()) void entry;
      }).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
        readerLimit: {
          parameter: "artifact_limits.expanded_bytes",
          effective_value: 16,
          required_value: declared,
        },
      });
    } finally {
      await reader.close();
    }
  });

  it("charges the allowance before it reads the checksum window", async () => {
    // A boot address of 0 is only found after the window is read; the
    // allowance refusal must come first, from the size and byte order alone.
    const image = n64RomImage({ order: "v64", bootAddress: 0 });
    const path = await createTestTempFile(
      "rea-n64-budget-first-",
      "game.v64",
      image.encoded,
    );
    const reader = new N64RomArtifactReader(path, undefined, 1024);
    try {
      await expect(async () => {
        for await (const entry of reader.entries()) void entry;
      }).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
        readerLimit: {
          parameter: "artifact_limits.expanded_bytes",
          effective_value: 1024,
        },
      });
    } finally {
      await reader.close();
    }
  });

  it("still extracts the program when the CIC is unknown or the CRC mismatches", async () => {
    const unknown = await read(n64RomImage({ cic: "unknown" }).encoded);
    expect(unknown.metadata).toMatchObject({
      cic: "unknown",
      crc: { status: "not-checked" },
    });
    expect(unknown.entries.map((entry) => entry.path)).toContain("program.z64");
    expect(unknown.coverage?.limitations.join("\n")).toContain(
      "matches none of the known CIC",
    );

    const mismatch = await read(n64RomImage({ crc: "mismatch" }).encoded);
    expect(mismatch.metadata?.crc.status).toBe("mismatch");
    expect(mismatch.coverage?.status).toBe("unknown");
    expect(mismatch.coverage?.limitations.join("\n")).toContain(
      "differ from computed",
    );
    expect(
      mismatch.contents
        .get("program.z64")
        ?.equals(n64RomImage({ crc: "mismatch" }).normalized),
    ).toBe(true);
  });

  it("omits ipl3.bin when the boot code is incomplete", async () => {
    const image = n64RomImage();
    const result = await read(image.encoded.subarray(0, N64_HEADER_BYTES));
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "header.bin",
      "program.z64",
    ]);
    expect(result.metadata).toMatchObject({
      cic: "unknown",
      ipl3_crc32: null,
      crc: { status: "not-checked" },
    });
    expect(result.coverage?.limitations.join("\n")).toContain(
      "boot code is incomplete",
    );
    expect(
      result.contents
        .get("program.z64")
        ?.equals(image.normalized.subarray(0, N64_HEADER_BYTES)),
    ).toBe(true);
  });

  it.each(["v64", "n64"] as const)(
    "cancels a decoded %s member before and during its read",
    async (order) => {
      const image = n64RomImage({ order });
      const reader = new N64RomArtifactReader(
        await createTestTempFile(
          "rea-n64-cancel-",
          `game.${order}`,
          image.encoded,
        ),
      );
      try {
        const entries: ArtifactEntry[] = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const program = entries.find((entry) => entry.path === "program.z64");
        expect(program).toBeDefined();

        const before = new AbortController();
        const beforeReason = new Error("cancel before read");
        const idle = await reader.open(program!, before.signal);
        before.abort(beforeReason);
        await setImmediate();
        expect(idle.destroyed).toBe(true);
        await expect(buffer(idle)).rejects.toMatchObject({
          reason: "cancelled",
          cause: beforeReason,
        });

        const during = new AbortController();
        const duringReason = new Error("cancel during read");
        const stream = await reader.open(program!, during.signal);
        const pending = stream[Symbol.asyncIterator]().next();
        during.abort(duringReason);
        await expect(pending).rejects.toMatchObject({
          reason: "cancelled",
          cause: duringReason,
        });

        expect(
          (await buffer(await reader.open(program!))).equals(image.normalized),
        ).toBe(true);
      } finally {
        await reader.close();
      }
    },
  );
});
