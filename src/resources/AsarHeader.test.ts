import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { expect, it, vi } from "vitest";

import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";
import {
  admitAsarHeader,
  readAsarHeader,
  createAsarHeaderSignatureProbe,
} from "./AsarHeader.js";

const makeArchive = (): Buffer => asarHeaderBytes(' \t\r\n{"files":{}} ');

const positionalHeader = (archive: Buffer, maxRead = archive.length) => {
  const read = vi.fn(
    async (
      target: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytesRead = Math.min(maxRead, length, archive.length - position);
      archive.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    },
  );
  return {
    read,
    handle: {
      read: read as unknown as FileHandle["read"],
      stat: async () => ({ isFile: () => true, size: archive.length }) as Stats,
    },
  };
};

it("recognizes JSON whitespace before the object token and finalizes file extents", () => {
  const archive = makeArchive();
  const probe = createAsarHeaderSignatureProbe();
  probe.write(archive.subarray(0, 7));
  expect(probe.observation.state).toBe("pending");
  probe.write(archive.subarray(7, 21));
  expect(probe.observation.state).toBe("matched");
  const result = probe.finish(archive.length);
  expect(result).toMatchObject({
    state: "matched",
    extents: {
      archiveBytes: archive.length,
      headerBytes: archive.readUInt32LE(4),
      jsonBytes: archive.readUInt32LE(12),
    },
    signatureOffset: 20,
  });
});

it("rejects a signature whose declared header exceeds the observed archive", () => {
  const archive = makeArchive();
  const probe = createAsarHeaderSignatureProbe();
  probe.write(archive);
  expect(probe.finish(archive.length - 1)).toMatchObject({
    state: "rejected",
    reason: "archive-too-short",
  });
});

it("refuses a header that declares one member name twice", async () => {
  const archive = asarHeaderBytes(
    '{"files":{"a.js":{"size":10,"offset":"0"},"a.js":{"size":5,"offset":"10"}}}',
  );
  const { handle } = positionalHeader(archive);
  const extents = await admitAsarHeader(handle);
  await expect(readAsarHeader(handle, extents)).rejects.toMatchObject({
    reason: "format",
    message: expect.stringContaining('"a.js"'),
  });
});

it("admits the fixed prefix and decodes JSON across short reads without consuming padding", async () => {
  const archive = asarHeaderBytes('{"files":{"�":{}}}', {
    padding: Buffer.from([0xff]),
  });
  const { handle, read } = positionalHeader(archive, 3);
  const extents = await admitAsarHeader(handle);
  expect(extents).toEqual({
    archiveBytes: archive.length,
    headerBytes: archive.readUInt32LE(4),
    jsonBytes: archive.readUInt32LE(12),
  });
  expect(
    read.mock.calls.map(([, offset, length, position]) => [
      offset,
      length,
      position,
    ]),
  ).toEqual([
    [0, 16, 0],
    [3, 13, 3],
    [6, 10, 6],
    [9, 7, 9],
    [12, 4, 12],
    [15, 1, 15],
  ]);
  await expect(readAsarHeader(handle, extents)).resolves.toEqual({
    files: { "�": {} },
  });
  await expect(
    readAsarHeader(
      {
        read: (async (target: Buffer) => ({
          bytesRead: 0,
          buffer: target,
        })) as FileHandle["read"],
      },
      extents,
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/truncated.*header/iu),
  });
});
