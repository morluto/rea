import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer, text } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { buildWxapkg } from "../../tests/fixtures/wxapkg.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { WxapkgArtifactReader } from "./WxapkgArtifactReader.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-wxapkg-boundary-"),
    "package.wxapkg",
  );
  await writeFile(path, bytes);
  return path;
};
const entries = async (reader: WxapkgArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

describe("wxapkg allocation and malformed-input boundaries", () => {
  it("admits the encoded table budget before reading it", async () => {
    const bytes = buildWxapkg([{ path: "a", data: "x" }]);
    bytes.writeUInt32BE(17 * 1024 * 1024, 5);
    const file = Buffer.alloc(18 + 17 * 1024 * 1024);
    bytes.copy(file);
    const path = await fixture(file);
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = new WxapkgArtifactReader(path, admitted);
    const reads = vi.spyOn(admitted.handle, "read");
    try {
      await expect(entries(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
      });
      expect(reads).toHaveBeenCalledTimes(1); // bounded header only
    } finally {
      await reader.close();
      reads.mockRestore();
      await admitted.handle.close();
    }
  });

  it("reserves row storage before constructing a large member array", async () => {
    // 140k minimal rows fit the encoded table budget but exceed the retained
    // directory representation budget mid-parse.
    const fileCount = 140_000;
    const tableBytes = fileCount * 13;
    const file = Buffer.alloc(18 + tableBytes);
    file[0] = 0xbe;
    file.writeUInt32BE(0, 1);
    file.writeUInt32BE(tableBytes, 5);
    file.writeUInt32BE(0, 9);
    file[13] = 0xed;
    file.writeUInt32BE(fileCount, 14);
    for (let index = 0; index < fileCount; index++) {
      const row = 18 + index * 13;
      file.writeUInt32BE(1, row);
      file[row + 4] = 0x61;
      file.writeUInt32BE(18, row + 5);
      file.writeUInt32BE(0, row + 9);
    }
    const reader = new WxapkgArtifactReader(await fixture(file));
    try {
      await expect(entries(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
      });
    } finally {
      await reader.close();
    }
  });

  it("charges overlapping readable members, not only their unique range", async () => {
    const size = 1024 * 1024;
    const members = Array.from({ length: 600 }, (_, index) => ({
      path: `alias-${String(index)}`,
      data: index === 0 ? Buffer.alloc(size, 0x61) : Buffer.alloc(0),
      size,
    }));
    const reader = new WxapkgArtifactReader(
      await fixture(buildWxapkg(members, { aliasOffsets: true })),
    );
    try {
      await expect(entries(reader)).rejects.toMatchObject({ reason: "limit" });
    } finally {
      await reader.close();
    }
  });

  it("types a short later row after an overstated first name consumes its bytes", async () => {
    const bytes = buildWxapkg([
      { path: "a".repeat(40), data: "x" },
      { path: "b", data: "y" },
    ]);
    // The first row's declared name consumes most of the second row. The
    // minimum total table-size check alone cannot establish each later row.
    bytes.writeUInt32BE(50, 18);
    const reader = new WxapkgArtifactReader(await fixture(bytes));
    try {
      await expect(entries(reader)).rejects.toMatchObject({ reason: "format" });
    } finally {
      await reader.close();
    }
  });
});

describe("wxapkg stream ownership", () => {
  it("retains descriptor ownership after cleanup fails and permits retry", async () => {
    const reader = new WxapkgArtifactReader(
      await fixture(buildWxapkg([{ path: "x", data: "bytes" }])),
    );
    const [entry] = await entries(reader);
    const stream = await reader.open(entry!);
    const failure = new Error("descriptor close denied");
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockRejectedValueOnce(failure);
    try {
      await expect(reader.close()).rejects.toBe(failure);
      expect(stream.closed).toBe(true);
      await expect(reader.open(entry!)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await reader.close();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
      await reader.close();
    }
  });

  it("joins an outstanding positional read before close completes", async () => {
    const path = await fixture(buildWxapkg([{ path: "x", data: "bytes" }]));
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = new WxapkgArtifactReader(path, admitted);
    const reached = createDeferred<void>(),
      release = createDeferred<void>();
    const nativeRead = admitted.handle.read.bind(admitted.handle);
    const [entry] = await entries(reader);
    const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      reached.resolve();
      await release.promise;
      return Reflect.apply(nativeRead, admitted.handle, args);
    }) as typeof admitted.handle.read);
    try {
      const stream = await reader.open(entry!);
      stream.read(0);
      await reached.promise;
      let closed = false;
      const closing = reader.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(stream.closed).toBe(true);
    } finally {
      release.resolve();
      await reader.close();
      reads.mockRestore();
      await admitted.handle.close();
    }
  });

  it("preserves cancellation inside a member read", async () => {
    const data = Buffer.alloc(256 * 1024, 0x61);
    const path = await fixture(buildWxapkg([{ path: "x", data }]));
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = new WxapkgArtifactReader(path, admitted);
    const controller = new AbortController();
    const reason = new Error("cancel during member read");
    const nativeRead = admitted.handle.read.bind(admitted.handle);
    const [entry] = await entries(reader);
    const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await Reflect.apply(nativeRead, admitted.handle, args);
      globalThis.setImmediate(() => {
        controller.abort(reason);
      });
      return result;
    }) as typeof admitted.handle.read);
    try {
      await expect(
        buffer(await reader.open(entry!, controller.signal)),
      ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    } finally {
      await reader.close();
      reads.mockRestore();
      await admitted.handle.close();
    }
  });
});

describe("wxapkg stream capacity and freshness", () => {
  it("bounds active streams and releases capacity after abandonment", async () => {
    const reader = new WxapkgArtifactReader(
      await fixture(buildWxapkg([{ path: "x", data: "bytes" }])),
    );
    try {
      const [entry] = await entries(reader);
      const streams = await Promise.all(
        Array.from({ length: 4 }, () => reader.open(entry!)),
      );
      await expect(reader.open(entry!)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
      const closed = new Promise<void>((resolve) => {
        streams[0]!.once("close", resolve);
      });
      streams[0]!.destroy();
      await closed;
      expect(await text(await reader.open(entry!))).toBe("bytes");
    } finally {
      await reader.close();
    }
  });

  it("bounds repeated member I/O operations", async () => {
    const reader = new WxapkgArtifactReader(
      await fixture(buildWxapkg([{ path: "x", data: "b" }])),
    );
    try {
      const [entry] = await entries(reader);
      await expect(
        (async () => {
          for (let index = 0; index < 5000; index++)
            await buffer(await reader.open(entry!));
        })(),
      ).rejects.toMatchObject({ reason: "limit", boundary: "capacity" });
    } finally {
      await reader.close();
    }
  });

  it("validates freshness before serving member bytes", async () => {
    const bytes = buildWxapkg([{ path: "x", data: "before" }]);
    const path = await fixture(bytes);
    const reader = new WxapkgArtifactReader(path);
    try {
      const [entry] = await entries(reader);
      expect(await text(await reader.open(entry!))).toBe("before");
      await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
      await expect(reader.open(entry!)).rejects.toMatchObject({
        reason: "integrity",
      });
    } finally {
      await reader.close();
    }
  });

  it("does not turn a paused inventory into complete coverage when closed", async () => {
    const reader = new WxapkgArtifactReader(
      await fixture(
        buildWxapkg([
          { path: "x", data: "bytes" },
          { path: "y", data: "bytes" },
        ]),
      ),
    );
    const iterator = reader.entries()[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).done).toBe(false);
      await reader.close();
      await expect(iterator.next()).rejects.toMatchObject({
        reason: "unavailable",
      });
    } finally {
      await reader.close();
    }
  });
});
