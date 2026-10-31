import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectWindowsMinidumpInputSchema,
  windowsMinidumpSchema,
} from "../../domain/native/windowsMinidump.js";
import { parseWindowsMinidump } from "./WindowsMinidumpParser.js";
import { windowsMinidumpFixture } from "./WindowsMinidump.fixture.js";

const PATH = "/fixtures/recorded.dmp";
const parse = (bytes: Buffer, maxEntries = 4096, signal?: AbortSignal) =>
  parseWindowsMinidump(
    bytes,
    {
      path: PATH,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectWindowsMinidumpInputSchema.parse({
      path: PATH,
      max_entries: maxEntries,
    }),
    signal,
  );
const rejection = (bytes: Buffer, pattern: RegExp) =>
  expect(parse(bytes)).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(pattern),
  });

describe("offline Windows minidump parsing", () => {
  it("reports streams, threads, exception, modules and memory independently", async () => {
    const fixture = windowsMinidumpFixture();
    const result = windowsMinidumpSchema.parse(await parse(fixture.bytes));
    expect(result.header).toMatchObject({
      version: 0xa793,
      stream_count: 8,
      timestamp: 0x60000000,
      flags: "0x1",
    });
    expect(result.streams.map((s) => [s.type, s.interpretation])).toEqual([
      [7, "interpreted"],
      [3, "interpreted"],
      [4, "interpreted"],
      [5, "interpreted"],
      [6, "interpreted"],
      [9, "interpreted"],
      [15, "unknown"],
      [0, "unused"],
    ]);
    expect(result.system).toMatchObject({
      architecture: "amd64",
      build_number: 22631,
    });
    const [thread] = result.threads;
    expect(thread).toMatchObject({
      historical_thread_id: 4242,
      teb: "0x5000",
      stack: {
        start_address: "0x7ffe0000",
        location: { offset: fixture.stackRva, bytes: 20 },
      },
    });
    const registers = new Map(
      thread!.context.registers!.map((r) => [r.name, r]),
    );
    expect(registers.get("rax")?.value).toBe("0xffffffffffffffff");
    expect(registers.get("rip")?.value).toBe("0x7ff612341234");
    expect(registers.get("cs")).toMatchObject({ value: "0x33" });
    const rip = registers.get("rip")!.location;
    expect(fixture.bytes.readBigUInt64LE(rip.offset)).toBe(0x7ff612341234n);
    expect(result.exception).toMatchObject({
      historical_thread_id: 4242,
      code: 0xc0000005,
      address: "0x7ff612341234",
      declared_parameters: 2,
      parameters: ["0x1", "0xdead"],
    });
    expect(result.modules).toEqual([
      expect.objectContaining({
        base_address: "0x7ff612340000",
        recorded_name: "C:\\Recorded\\app.exe",
      }),
    ]);
    expect(result.memory.map((m) => [m.source, m.start_address])).toEqual([
      ["memory-list", "0x7ffe0000"],
      ["memory64-list", "0x10000"],
    ]);
    expect(result.memory[1]!.location.offset).toBe(fixture.memory64Rva);
    expect(result.coverage).toMatchObject({ unknown_streams: 1 });
    expect(result.limitations.join(" ")).toMatch(/never select, attach/);
  });

  it("locates but does not interpret non-AMD64 contexts", async () => {
    const result = await parse(
      windowsMinidumpFixture({ architecture: 12 }).bytes,
    );
    expect(result.system?.architecture).toBe("arm64");
    expect(result.threads[0]!.context.registers).toBeNull();
    expect(result.threads[0]!.context.location.bytes).toBe(1232);
  });

  it("keeps absent streams explicit instead of claiming absence at the crash", async () => {
    const { bytes, directoryRva } = windowsMinidumpFixture();
    // Retype ExceptionStream and SystemInfoStream entries as unused.
    bytes.writeUInt32LE(0, directoryRva + 4 * 12);
    bytes.writeUInt32LE(0, directoryRva);
    const result = await parse(bytes);
    expect(result.exception).toBeNull();
    expect(result.system).toBeNull();
    expect(result.threads[0]!.context.registers).toBeNull();
    expect(result.limitations.join(" ")).toMatch(/ExceptionStream is absent/);
  });

  it("rejects a non-minidump signature and a truncated file", async () => {
    await rejection(Buffer.alloc(64), /signature/);
    await expect(parse(Buffer.from("MDMP"))).rejects.toMatchObject({
      reason: "format",
    });
    const { bytes } = windowsMinidumpFixture();
    await rejection(bytes.subarray(0, bytes.length - 4), /truncated/);
  });

  it("rejects a stream RVA beyond the file", async () => {
    const { bytes, directoryRva } = windowsMinidumpFixture();
    bytes.writeUInt32LE(bytes.length, directoryRva + 12 + 8);
    await rejection(bytes, /truncated/);
  });

  it("rejects overlapping stream ranges", async () => {
    const { bytes, directoryRva, streams } = windowsMinidumpFixture();
    bytes.writeUInt32LE(streams.get(7)!.offset + 8, directoryRva + 6 * 12 + 8);
    await rejection(bytes, /Overlapping/);
  });

  it("rejects overlapping memory content ranges", async () => {
    const { bytes, streams, stackRva } = windowsMinidumpFixture();
    bytes.writeBigUInt64LE(BigInt(stackRva + 2), streams.get(9)!.offset + 8);
    await rejection(bytes, /Overlapping/);
  });

  it("rejects incomplete thread, exception and duplicate streams", async () => {
    const thread = windowsMinidumpFixture();
    thread.bytes.writeUInt32LE(2, thread.streams.get(3)!.offset);
    await rejection(thread.bytes, /incomplete/);
    const exception = windowsMinidumpFixture();
    exception.bytes.writeUInt32LE(100, exception.directoryRva + 4 * 12 + 4);
    await rejection(exception.bytes, /ExceptionStream is incomplete/);
    const duplicate = windowsMinidumpFixture();
    duplicate.bytes.writeUInt32LE(3, duplicate.directoryRva + 6 * 12);
    await rejection(duplicate.bytes, /Duplicate ThreadListStream/);
  });

  it("enforces the entry budget and cancellation", async () => {
    const { bytes } = windowsMinidumpFixture();
    await expect(parse(bytes, 4)).rejects.toMatchObject({ reason: "limit" });
    await expect(parse(bytes, 4096, AbortSignal.abort())).rejects.toBeDefined();
  });
});
