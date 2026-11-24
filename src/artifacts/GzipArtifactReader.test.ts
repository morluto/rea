import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { GzipArtifactReader } from "./GzipArtifactReader.js";

const buildGzipWithFname = (
  payload: Buffer,
  fname: string,
  extraField?: Buffer,
): Buffer => {
  const baseCompressed = gzipSync(payload);
  const header = Buffer.from(baseCompressed.subarray(0, 10));
  header[3] = (extraField === undefined ? 0 : 0x04) | 0x08;
  const parts: Buffer[] = [header];
  if (extraField !== undefined) parts.push(extraField);
  parts.push(Buffer.from(`${fname}\0`, "latin1"));
  parts.push(baseCompressed.subarray(10));
  return Buffer.concat(parts);
};

describe("GzipArtifactReader", () => {
  it("extracts and streams compressed content correctly", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-test-");
    const gzipPath = join(tempDir, "solve_me.gz");
    const payload = Buffer.from("ELF binary test payload for CTF challenge");
    await writeFile(gzipPath, gzipSync(payload));

    const reader = new GzipArtifactReader(gzipPath);
    try {
      expect(reader.format).toBe("gzip");

      const entries = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0]!.path).toBe("solve_me");
      expect(entries[0]!.kind).toBe("file");
      expect(entries[0]!.executable).toBe(false);
      expect(entries[0]!.byteOffset).toBeNull();
      expect(entries[0]!.declaredSize).toBeNull();

      const stream = await reader.open(entries[0]!);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString("utf-8")).toBe(
        "ELF binary test payload for CTF challenge",
      );
    } finally {
      await reader.close();
    }
  });

  it("falls back to decompressed_payload when archive basename is literally .gz", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-dot-test-");
    const gzipPath = join(tempDir, ".gz");
    await writeFile(gzipPath, gzipSync(Buffer.from("payload")));

    const reader = new GzipArtifactReader(gzipPath);
    try {
      const entries = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }
      expect(entries).toHaveLength(1);
      expect(entries[0]!.path).toBe("decompressed_payload");
    } finally {
      await reader.close();
    }
  });

  it("extracts FNAME when preceded by a large FEXTRA field exceeding 512 bytes and preserves whitespace", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-fextra-test-");
    const gzipPath = join(tempDir, "carrier.gz");
    const extraLen = 1024;
    const extraField = Buffer.alloc(2 + extraLen, 0x41);
    extraField.writeUInt16LE(extraLen, 0);

    await writeFile(
      gzipPath,
      buildGzipWithFname(
        Buffer.from("inner payload"),
        " report .bin ",
        extraField,
      ),
    );

    const reader = new GzipArtifactReader(gzipPath);
    try {
      const entries = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }
      expect(entries).toHaveLength(1);
      expect(entries[0]!.path).toBe(" report .bin ");
      expect(entries[0]!.limitations).toEqual([]);
    } finally {
      await reader.close();
    }
  });

  it("records a limitation and retains sourcePath when FNAME is unsafe or drive-prefixed", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-unsafe-fname-");
    for (const badName of [
      "../evil.bin",
      "C:payload",
      "C:/payload.bin",
      "dir\\payload.bin",
    ]) {
      const gzipPath = join(tempDir, "archive.gz");
      await writeFile(
        gzipPath,
        buildGzipWithFname(Buffer.from("inner payload"), badName),
      );

      const reader = new GzipArtifactReader(gzipPath);
      try {
        const coverages: unknown[] = [];
        const entries = [];
        for await (const entry of reader.entries(undefined, {
          onCoverage: (cov) => coverages.push(cov),
        })) {
          entries.push(entry);
        }

        expect(entries).toHaveLength(1);
        expect(entries[0]!.path).toBe("archive");
        expect(entries[0]!.sourcePath).toBe(badName);
        expect(entries[0]!.limitations[0]).toMatch(/unsafe or empty path/);
        expect(coverages).toEqual([
          {
            status: "complete",
            limitations: entries[0]!.limitations,
          },
        ]);
      } finally {
        await reader.close();
      }
    }
  });

  it("normalizes carrier-derived fallback names that fail artifact path validation", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-carrier-fallback-");
    const backingPath = join(tempDir, "carrier.gz");
    await writeFile(backingPath, gzipSync(Buffer.from("payload")));
    const handle = await open(backingPath, "r");
    try {
      const initial = await handle.stat();
      for (const unsafeCarrierPath of [
        "/tmp/...gz",
        "/tmp/..gz",
        "/tmp/C:payload.gz",
        "/tmp/\0bad.gz",
        "/tmp/\0bad",
      ]) {
        const reader = new GzipArtifactReader(unsafeCarrierPath, {
          handle,
          initial,
        });
        try {
          const entries = [];
          for await (const entry of reader.entries()) {
            entries.push(entry);
          }
          expect(entries).toHaveLength(1);
          expect(entries[0]!.path).toBe("decompressed_payload");
        } finally {
          await reader.close();
        }
      }
    } finally {
      await handle.close();
    }
  });

  it("binds prepareContainer to the inventoried carrier digest", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-prepare-");
    const gzipPath = join(tempDir, "bound.gz");
    const compressed = gzipSync(Buffer.from("same payload"));
    await writeFile(gzipPath, compressed);
    const expectedSha = createHash("sha256").update(compressed).digest("hex");

    const reader = new GzipArtifactReader(gzipPath);
    try {
      await expect(
        reader.prepareContainer(expectedSha),
      ).resolves.toBeUndefined();
      await expect(
        reader.prepareContainer("0".repeat(64)),
      ).rejects.toMatchObject({
        reason: "integrity",
      });
    } finally {
      await reader.close();
    }
  });

  it("converts damaged GZIP checksum errors into tagged format failures without closing a borrowed handle", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-corrupt-");
    const gzipPath = join(tempDir, "damaged.gz");
    const damaged = Buffer.from(
      gzipSync(Buffer.from("integrity check payload")),
    );
    // Flip a CRC32 trailer byte to trigger Z_DATA_ERROR
    damaged[damaged.length - 6]! ^= 0xff;
    await writeFile(gzipPath, damaged);

    const handle = await open(gzipPath, "r");
    const owner = new OwnedFileHandle(handle);
    try {
      const initial = await handle.stat();
      const reader = new GzipArtifactReader(gzipPath, { handle, initial });
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const stream = await reader.open(entries[0]!);
        let caught: unknown;
        try {
          for await (const _chunk of stream) {
            // drain until trailer failure
          }
        } catch (cause: unknown) {
          caught = cause;
        }
        expect(caught).toBeInstanceOf(ArtifactReaderFailure);
        expect(caught).toMatchObject({ reason: "format" });
      } finally {
        await reader.close();
      }
      // Borrowed handle must still be open and cleanly closeable by its owner
      await expect(handle.stat()).resolves.toBeDefined();
    } finally {
      await owner.close();
    }
  });

  it("enforces expansion limits and preserves borrowed handle ownership on limit and cancellation", async () => {
    const tempDir = await createTestTempDirectory("rea-gzip-budget-");
    const gzipPath = join(tempDir, "expand.gz");
    await writeFile(gzipPath, gzipSync(Buffer.alloc(64 * 1024, 0x41)));

    const handle = await open(gzipPath, "r");
    const owner = new OwnedFileHandle(handle);
    try {
      const initial = await handle.stat();
      const reader = new GzipArtifactReader(
        gzipPath,
        { handle, initial },
        1024,
      );
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const stream = await reader.open(entries[0]!);
        let caught: unknown;
        try {
          for await (const _chunk of stream) {
            // drain until limit failure
          }
        } catch (cause: unknown) {
          caught = cause;
        }
        expect(caught).toBeInstanceOf(ArtifactReaderFailure);
        expect(caught).toMatchObject({ reason: "limit" });

        // Cancellation also leaves the borrowed handle owned by its caller
        const abort = new AbortController();
        const stream2 = await reader.open(entries[0]!, abort.signal);
        abort.abort("stop");
        await expect(
          (async () => {
            for await (const _chunk of stream2) {
              // wait for cancellation
            }
          })(),
        ).rejects.toMatchObject({ reason: "cancelled" });
      } finally {
        await reader.close();
      }
      await expect(handle.stat()).resolves.toBeDefined();
    } finally {
      await owner.close();
    }
  });
});
