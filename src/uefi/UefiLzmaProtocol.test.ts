import { once } from "node:events";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { LzmaFrameReader } from "./UefiLzmaProtocol.js";

const MIB = 1024 * 1024;

const openReader = async () => {
  const stream = new Readable({ read() {} });
  const flowing = once(stream, "resume");
  const reader = new LzmaFrameReader(stream);
  await flowing;
  return {
    stream,
    reader,
    close: () => {
      reader.dispose();
      stream.destroy();
    },
  };
};

it("reads a fragmented body larger than the pause threshold", async () => {
  const { stream, reader, close } = await openReader();
  try {
    const fragments = Array.from({ length: 5 }, (_, index) =>
      Buffer.alloc(MIB, index + 1),
    );
    const paused = once(stream, "pause");
    const result = reader.readExact(5 * MIB);
    for (const fragment of fragments.slice(0, 4)) stream.push(fragment);
    await paused;
    stream.push(fragments[4]!);
    expect((await result).equals(Buffer.concat(fragments))).toBe(true);
  } finally {
    close();
  }
});

it("resumes a paused reader once its queued bytes fall below two MiB", async () => {
  const { stream, reader, close } = await openReader();
  try {
    const paused = once(stream, "pause");
    stream.push(Buffer.alloc(4 * MIB, 0x71));
    await paused;
    expect((await reader.readExact(2 * MIB)).length).toBe(2 * MIB);
    expect(stream.isPaused()).toBe(true);

    const resumed = once(stream, "resume");
    expect((await reader.readExact(1)).equals(Buffer.from([0x71]))).toBe(true);
    await resumed;
    expect(stream.isPaused()).toBe(false);
  } finally {
    close();
  }
});

it("aborts a pending large-body read when its stream pauses", async () => {
  const { stream, reader, close } = await openReader();
  try {
    const controller = new AbortController();
    const reason = new Error("cancelled LZMA read");
    stream.once("pause", () => controller.abort(reason));
    const result = reader.readExact(5 * MIB, { signal: controller.signal });
    stream.push(Buffer.alloc(4 * MIB));
    await expect(result).rejects.toBe(reason);
    expect(stream.isPaused()).toBe(true);
  } finally {
    close();
  }
});
