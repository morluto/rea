import { createHash } from "node:crypto";
import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import { inspectWindowsMinidumpInputSchema } from "../../domain/native/windowsMinidump.js";
import { parseWindowsMinidump } from "./WindowsMinidumpParser.js";
import { windowsMinidumpFixture } from "./WindowsMinidump.fixture.js";

const PATH = "/fixtures/recorded.dmp";
const parse = (bytes: Buffer, signal?: AbortSignal) =>
  parseWindowsMinidump(
    bytes,
    {
      path: PATH,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectWindowsMinidumpInputSchema.parse({ path: PATH }),
    signal,
  );

/** A dump with one list stream of `type` whose body is `body`, plus `tail`. */
const singleStreamDump = (
  type: number,
  body: Buffer,
  tail = Buffer.alloc(0),
) => {
  const directoryRva = 32;
  const bodyRva = directoryRva + 12;
  const bytes = Buffer.concat([Buffer.alloc(bodyRva), body, tail]);
  bytes.writeUInt32LE(0x504d444d, 0);
  bytes.writeUInt32LE(0xa793, 4);
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(directoryRva, 12);
  bytes.writeUInt32LE(type, directoryRva);
  bytes.writeUInt32LE(body.length, directoryRva + 4);
  bytes.writeUInt32LE(bodyRva, directoryRva + 8);
  return { bytes, tailRva: bodyRva + body.length };
};

describe("minidump review regressions", () => {
  it("caps cumulative module-name decoding before allocating strings", async () => {
    const count = 300;
    const nameBytes = 65534;
    const body = Buffer.alloc(4 + count * 108);
    body.writeUInt32LE(count, 0);
    const name = Buffer.alloc(4 + nameBytes, 0x41);
    name.writeUInt32LE(nameBytes, 0);
    const { bytes, tailRva } = singleStreamDump(4, body, name);
    for (let index = 0; index < count; index++)
      bytes.writeUInt32LE(tailRva, 32 + 12 + 4 + index * 108 + 20);
    await expect(parse(bytes)).rejects.toMatchObject({
      reason: "limit",
      message: expect.stringMatching(/decoding budget/),
    });
  });

  it("rejects a thread stack that partially overlaps listed memory", async () => {
    const { bytes, streams, stackRva } = windowsMinidumpFixture();
    // Thread 0 stack RVA shifted by two bytes, still inside the file.
    bytes.writeUInt32LE(stackRva + 2, streams.get(3)!.offset + 4 + 36);
    await expect(parse(bytes)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(/Overlapping .*stack/),
    });
  });

  it("still accepts a stack identical to its memory-list alias", async () => {
    const { bytes } = windowsMinidumpFixture();
    expect((await parse(bytes)).coverage.status).toBe("complete");
  });

  it("rejects exception records declaring more than 15 parameters", async () => {
    const { bytes, streams } = windowsMinidumpFixture();
    bytes.writeUInt32LE(16, streams.get(6)!.offset + 32);
    await expect(parse(bytes)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(/at most 15/),
    });
  });

  it("observes cancellation while walking a large descriptor list", async () => {
    const count = 3000;
    const body = Buffer.alloc(4 + count * 16);
    body.writeUInt32LE(count, 0);
    const { bytes } = singleStreamDump(5, body);
    const controller = new AbortController();
    // Abort on the second event-loop turn: after the pre-list yield but while
    // the descriptor loop must still be running.
    setImmediate(() => setImmediate(() => controller.abort()));
    await expect(parse(bytes, controller.signal)).rejects.toBeDefined();
  });
});
