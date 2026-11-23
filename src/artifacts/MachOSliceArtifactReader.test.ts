import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { CPU, fatImage, machoImage } from "./apple/MachoImage.fixture.js";
import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";
import { err, ok } from "../domain/result.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import type { NativeCommandRunner } from "../providers/NativeCommandRunner.js";
import { NativeCommandFailure } from "../providers/NativeCommandRunner.js";
import {
  phaseArrival,
  phaseGate,
} from "../../tests/support/lifecycleHarness.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { ArtifactEntry } from "../resources/ArtifactReader.js";

const sliceOwnershipFixture = async (secondSlice = false) => {
  const root = await createTestTempDirectory("rea-slice-ownership-");
  const path = join(root, "fat");
  const bytes = Buffer.concat([
    Buffer.from(machoImage({ cpu: CPU.x86_64 })),
    Buffer.alloc(256 * 1024),
  ]);
  const slices = [
    { name: "x86_64", cpu: CPU.x86_64, bytes },
    ...(secondSlice
      ? [
          {
            name: "arm64",
            cpu: CPU.arm64,
            bytes: machoImage({ cpu: CPU.arm64 }),
          },
        ]
      : []),
  ];
  await writeFile(path, fatImage(slices));
  const runner: NativeCommandRunner = {
    run: async () =>
      ok({
        tool: "lipo",
        executable: "/usr/bin/lipo",
        executableSha256: "1".repeat(64),
        toolVersion: null,
        versionReason: "fixture",
        arguments: ["-detailed_info", path],
        stdout: slices
          .map(
            ({ name, cpu, bytes }, index) =>
              `architecture ${name}\n cputype ${cpu.type}\n cpusubtype ${cpu.subtype}\n offset ${index === 0 ? 4096 : Math.ceil((4096 + slices[0]!.bytes.length) / 4096) * 4096}\n size ${bytes.length}\n align 2^12 (4096)\n`,
          )
          .join(""),
        stderr: "",
        stdoutBytes: 1,
        stderrBytes: 0,
        exitCode: 0,
        signal: null,
      }),
  };
  return { path, runner, bytes };
};

const sliceEntries = async (
  reader: MachOSliceArtifactReader,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
};

const cleanupOwner = (runId: string): ProviderProcessSupervisor => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  return new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    ownership: {
      runId,
      leaderPid: 45_000,
      processGroupId: 45_000,
      expectedParentPid: process.pid,
    },
    cleanup: async () => ({ cleaned: false, reason: "still running" }),
  });
};

describe("Mach-O cleanup exceptions", () => {
  it("retains an undefined cleanup rejection as an explicit failure", async () => {
    const reader = new MachOSliceArtifactReader(
      "/unused/macho",
      {},
      {
        run: async () => {
          throw new Error("Unexpected command");
        },
        retryCleanup: async () => {
          throw undefined;
        },
      },
    );
    await expect(reader.close()).rejects.toMatchObject({
      cleanup: {
        reason: "undefined",
        resources: ["native-command-process-cleanup"],
      },
    });
  });
});

describe("Mach-O command cleanup lifecycle", () => {
  it("waits for active lipo capture before cleanup and preserves its failure", async () => {
    const root = await createTestTempDirectory("rea-slices-close-race-");
    const binary = join(root, "input");
    await writeFile(binary, Buffer.from("fixture"));
    const capture = phaseGate<
      void,
      Awaited<ReturnType<NativeCommandRunner["run"]>>
    >();
    let cleanupRetries = 0;
    const runner: NativeCommandRunner = {
      run: () => capture.hold(),
      retryCleanup: async () => {
        cleanupRetries += 1;
        if (cleanupRetries > 1) return [];
        return [
          {
            owner: cleanupOwner("run:first"),
            reason: "first process group remains live",
            resources: ["run:first", "process-group:1234"],
          },
          {
            owner: cleanupOwner("run:second"),
            reason: "second process group remains live",
            resources: ["run:second", "process-group:5678"],
          },
        ];
      },
    };
    const reader = new MachOSliceArtifactReader(binary, {}, runner);
    const iteration = reader.entries();
    const firstEntry = iteration[Symbol.asyncIterator]().next();
    const commandResult = err(
      new NativeCommandFailure(
        "lipo",
        "timeout",
        null,
        undefined,
        {
          stdout: "partial lipo output",
          stderr: "partial lipo diagnostic",
          stdoutBytes: 19,
          stderrBytes: 23,
          exitCode: null,
          signal: null,
          truncated: false,
        },
        "capture process group remains unverified",
        ["capture-group:9999"],
      ),
    );
    try {
      await capture.reached(firstEntry, "lipo capture start");
      const closing = reader.close();
      await Promise.resolve();
      expect(cleanupRetries).toBe(0);
      capture.release(commandResult);
      await expect(firstEntry).rejects.toMatchObject({
        reason: "unavailable",
        cause: expect.objectContaining({
          cleanupFailure: "capture process group remains unverified",
        }),
        cleanup: {
          reason: "capture process group remains unverified",
          resources: ["capture-group:9999"],
        },
      });
      await expect(closing).rejects.toMatchObject({
        cleanup: {
          reason:
            "run:first, process-group:1234: first process group remains live; run:second, process-group:5678: second process group remains live",
          resources: [
            "run:first",
            "process-group:1234",
            "run:second",
            "process-group:5678",
          ],
        },
      });
      await reader.close();
      expect(cleanupRetries).toBe(2);
    } finally {
      capture.release(commandResult);
      await firstEntry.catch(() => undefined);
      await reader.close().catch(() => undefined);
    }
  });
});

describe("MachOSliceArtifactReader hidden architectures", () => {
  it("retains Apple's hidden ARM64 row separately from the declared FAT count", async () => {
    const root = await createTestTempDirectory("rea-hidden-arm64-slices-");
    const binary = join(root, "fat");
    const armv7 = { type: 12, subtype: 9 };
    const armv7Image = machoImage({ cpu: armv7, wide: false });
    const arm64Image = machoImage({ cpu: CPU.arm64 });
    const bytes = Buffer.from(
      fatImage([
        { cpu: armv7, bytes: armv7Image },
        { cpu: CPU.arm64, bytes: arm64Image },
      ]),
    );
    bytes.writeUInt32BE(1, 4);
    await writeFile(binary, bytes);
    const stdout = `fat_magic 0xcafebabe\nnfat_arch 1 (+1 hidden)\narchitecture armv7\n cputype 12\n cpusubtype 9\n offset 4096\n size ${String(armv7Image.length)}\n align 2^12 (4096)\narchitecture arm64 (hidden)\n cputype 16777228\n cpusubtype 0\n offset 8192\n size ${String(arm64Image.length)}\n align 2^12 (4096)\n`;
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      {
        run: async () =>
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: [],
            stdout,
            stderr: "",
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: 0,
            exitCode: 0,
            signal: null,
          }),
      },
    );
    onTestFinished(() => reader.close());
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries.map(({ path }) => path)).toEqual([
      "slices/armv7",
      "slices/arm64",
    ]);
  });

  it("rejects a lipo hidden ARM64 claim when its physical header disagrees", async () => {
    const root = await createTestTempDirectory("rea-hidden-arm64-mismatch-");
    const binary = join(root, "fat");
    const armv7 = { type: 12, subtype: 9 };
    const armv7Image = machoImage({ cpu: armv7, wide: false });
    const arm64Image = machoImage({ cpu: CPU.arm64 });
    const bytes = Buffer.from(
      fatImage([
        { cpu: armv7, bytes: armv7Image },
        { cpu: CPU.arm64, bytes: arm64Image },
      ]),
    );
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32LE(7, 8196); // Hidden FAT row claims ARM64; thin header says x86.
    await writeFile(binary, bytes);
    const stdout = `fat_magic 0xcafebabe\nnfat_arch 1 (+1 hidden)\narchitecture armv7\n cputype 12\n cpusubtype 9\n offset 4096\n size ${String(armv7Image.length)}\n align 2^12 (4096)\narchitecture arm64 (hidden)\n cputype 16777228\n cpusubtype 0\n offset 8192\n size ${String(arm64Image.length)}\n align 2^12 (4096)\n`;
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      {
        run: async () =>
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: [],
            stdout,
            stderr: "",
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: 0,
            exitCode: 0,
            signal: null,
          }),
      },
    );
    onTestFinished(() => reader.close());
    const enumerate = async (): Promise<void> => {
      for await (const _entry of reader.entries()) {
        /* enumerate */
      }
    };
    await expect(enumerate()).rejects.toMatchObject({ reason: "integrity" });
  });
});

describe("MachOSliceArtifactReader", () => {
  it("classifies malformed successful lipo output at the reader boundary", async () => {
    const root = await createTestTempDirectory("rea-slices-malformed-lipo-");
    const binary = join(root, "fat");
    await writeFile(
      binary,
      fatImage([
        { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
        { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      ]),
    );
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      {
        run: async () =>
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: ["-detailed_info", binary],
            stdout: "Fat header in: fixture\n",
            stderr: "",
            stdoutBytes: 23,
            stderrBytes: 0,
            exitCode: 0,
            signal: null,
          }),
      },
    );
    onTestFinished(() => reader.close());

    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(
        /lipo.*readable architecture records.*no architectures/i,
      ),
      cause: { failure: { kind: "malformed", format: "lipo-output" } },
    });
  });

  it("keeps a borrowed source usable after idle and active cancelled slice reads", async () => {
    const { path, runner, bytes } = await sliceOwnershipFixture(true);
    const source = await openRegularFile(path, { symlinks: "reject" });
    const { handle } = source;
    const reader = new MachOSliceArtifactReader(path, {}, runner, source);
    onTestFinished(async () => {
      try {
        await reader.close();
      } finally {
        await handle.close();
      }
    });

    const [entry] = await sliceEntries(reader);
    if (entry === undefined) throw new Error("Expected an x86_64 slice");
    const idleController = new AbortController();
    const idle = await reader.open(entry, idleController.signal);
    const idleFailure = once(idle, "error");
    idleController.abort(null);
    await expect(idleFailure).resolves.toMatchObject([
      { reason: "cancelled", cancellation: { reason: null } },
    ]);
    expect((await handle.stat()).isFile()).toBe(true);

    const read = handle.read.bind(handle);
    const activeRead = phaseGate();
    let reads = 0;
    const activeSpy = vi.spyOn(handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await Reflect.apply(read, handle, args);
      if (reads++ > 0) await activeRead.hold();
      return result;
    }) as typeof handle.read);
    try {
      const controller = new AbortController();
      const cancelled = await reader.open(entry, controller.signal);
      const iterator = cancelled[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.byteLength).toBeGreaterThan(0);
      const pending = iterator.next();
      void pending.catch(() => undefined);
      await activeRead.reached(
        pending,
        "slice descriptor read after the first chunk",
      );
      const reason = { stage: "descriptor read" };
      controller.abort(reason);
      activeRead.release();
      const failure = await pending.catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ reason: "cancelled" });
      expect((failure as Error).cause).toBe(reason);
    } finally {
      activeRead.release();
      activeSpy.mockRestore();
    }

    const [verified] = await sliceEntries(reader);
    if (verified === undefined)
      throw new Error("Expected the same slice after cancellation");
    expect(await buffer(await reader.open(verified))).toEqual(bytes);

    const controller = new AbortController();
    const truncated = await reader.open(verified, controller.signal);
    const bufferedCaller = new AbortController();
    const buffered = await reader.open(verified, bufferedCaller.signal);
    await truncate(path, 4097);
    const incomplete = { reason: "integrity", integrityCheck: "declared-size" };
    const eof = phaseGate();
    const returnedEof = phaseArrival();
    let eofCount = 0;
    const eofSpy = vi.spyOn(handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = (await Reflect.apply(read, handle, args)) as {
        bytesRead: number;
        buffer: Buffer;
      };
      if (result.bytesRead === 0) {
        if (eofCount++ === 0) await eof.hold();
        // After the real read returns, let the stream publish its coverage.
        else setImmediate(() => returnedEof.arrive());
      }
      return result;
    }) as typeof handle.read);
    try {
      const consumed = buffer(truncated);
      void consumed.catch(() => undefined);
      await eof.reached(consumed, "physical EOF within the declared slice");
      controller.abort(null);
      eof.release();
      await expect(consumed).rejects.toMatchObject(incomplete);

      const failure = once(buffered, "error");
      buffered.read(0);
      await returnedEof.reached(
        failure,
        "returned EOF with unconsumed slice data",
      );
      expect(buffered.readableLength).toBeGreaterThan(0);
      expect(buffered.destroyed).toBe(false);
      bufferedCaller.abort(null);
      expect(buffered.destroyed).toBe(true);
      await expect(failure).resolves.toMatchObject([incomplete]);
    } finally {
      eof.release();
      eofSpy.mockRestore();
    }
  });
});

describe("universal slices outside the structural index", () => {
  const PPC = { type: 18, subtype: 0 } as const;
  /** A minimal big-endian 32-bit Mach-O header, as a PowerPC slice stores it. */
  const bigEndianImage = (): Uint8Array => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(0xfeed_face, 0);
    bytes.writeUInt32BE(PPC.type, 4);
    bytes.writeUInt32BE(1, 12);
    return bytes;
  };
  /** An arm64 image whose load commands claim more bytes than the slice holds. */
  const malformedImage = (): Uint8Array => {
    const bytes = machoImage({ cpu: CPU.arm64 });
    new DataView(bytes.buffer).setUint32(20, 4096, true);
    return bytes;
  };
  const lipoRunner = (
    binary: string,
    slices: readonly {
      readonly name: string;
      readonly cpu: { readonly type: number; readonly subtype: number };
      readonly offset: number;
      readonly size: number;
    }[],
    withRanges = true,
  ): NativeCommandRunner => ({
    run: () =>
      Promise.resolve(
        ok({
          tool: "lipo",
          executable: "/usr/bin/lipo",
          executableSha256: "1".repeat(64),
          toolVersion: null,
          versionReason: "fixture",
          arguments: ["-detailed_info", binary],
          stdout: slices
            .map(
              ({ name, cpu, offset, size }) =>
                `architecture ${name}\n cputype ${String(cpu.type)}\n cpusubtype ${String(cpu.subtype)}\n${withRanges ? ` offset ${String(offset)}\n size ${String(size)}\n` : ""} align 2^12 (4096)\n`,
            )
            .join(""),
          stderr: "",
          stdoutBytes: 1,
          stderrBytes: 0,
          exitCode: 0,
          signal: null,
        }),
      ),
  });
  const readAll = async (
    slices: readonly {
      readonly name: string;
      readonly cpu: { readonly type: number; readonly subtype: number };
      readonly bytes: Uint8Array;
    }[],
    withRanges = true,
  ) => {
    const root = await createTestTempDirectory("rea-slices-unsupported-");
    const binary = join(root, "fat");
    await writeFile(binary, fatImage(slices));
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      lipoRunner(
        binary,
        slices.map(({ name, cpu, bytes }, index) => ({
          name,
          cpu,
          offset: 4096 * (index + 1),
          size: bytes.length,
        })),
        withRanges,
      ),
    );
    onTestFinished(() => reader.close());
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    return entries;
  };

  it("inventories every lipo range beside a big-endian slice", async () => {
    const entries = await readAll([
      { name: "ppc", cpu: PPC, bytes: bigEndianImage() },
      { name: "arm64", cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
    ]);
    expect(entries.map(({ path, byteOffset }) => [path, byteOffset])).toEqual([
      ["slices/ppc", 4096],
      ["slices/arm64", 8192],
    ]);
    expect(entries[0]?.limitations).toContainEqual(
      expect.stringMatching(
        /big.endian Mach.O.*not supported.*slice range.*lipo/iu,
      ),
    );
  });

  it("reports missing lipo ranges for an unindexed slice as unavailable support", async () => {
    await expect(
      readAll(
        [
          { name: "ppc", cpu: PPC, bytes: bigEndianImage() },
          {
            name: "arm64",
            cpu: CPU.arm64,
            bytes: machoImage({ cpu: CPU.arm64 }),
          },
        ],
        false,
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "rejects a malformed slice %s a big-endian slice",
    async (_order, malformedFirst) => {
      const ppc = { name: "ppc", cpu: PPC, bytes: bigEndianImage() };
      const broken = { name: "arm64", cpu: CPU.arm64, bytes: malformedImage() };
      await expect(
        readAll(malformedFirst ? [broken, ppc] : [ppc, broken]),
      ).rejects.toMatchObject({ reason: "integrity" });
    },
  );
});

describe("Mach-O slice stream ownership", () => {
  it.each(["unread", "abandoned", "cancelled"] as const)(
    "retires an %s opened slice before closing its carrier",
    async (mode) => {
      const fixture = await sliceOwnershipFixture();
      const reader = new MachOSliceArtifactReader(
        fixture.path,
        {},
        fixture.runner,
      );
      try {
        const [entry] = await sliceEntries(reader);
        const caller = new AbortController();
        const stream = await reader.open(entry!, caller.signal);
        await once(stream, "readable");
        if (mode === "abandoned") {
          for await (const _chunk of stream) break;
        } else if (mode === "cancelled") {
          const failure = once(stream, "error");
          const reason = { caller: "slice owner cancellation" };
          caller.abort(reason);
          await expect(failure).resolves.toMatchObject([
            { reason: "cancelled", cause: reason },
          ]);
        }
        await Promise.all([reader.close(), reader.close()]);
        expect(stream.destroyed).toBe(true);
        expect(stream.closed).toBe(true);
      } finally {
        await reader.close();
      }
    },
  );

  it("joins an admitted descriptor read before reader close completes", async () => {
    const fixture = await sliceOwnershipFixture();
    const source = await openRegularFile(fixture.path, { symlinks: "reject" });
    const reader = new MachOSliceArtifactReader(
      fixture.path,
      {},
      fixture.runner,
      source,
    );
    const sliceRead = phaseGate();
    const nativeRead = source.handle.read.bind(source.handle);
    let reads: { mockRestore(): void } | undefined;
    let consumed: Promise<Buffer> | undefined;
    try {
      const [entry] = await sliceEntries(reader);
      reads = vi.spyOn(source.handle, "read").mockImplementation((async (
        ...args: unknown[]
      ) => {
        await sliceRead.hold();
        return Reflect.apply(nativeRead, source.handle, args);
      }) as typeof source.handle.read);
      const stream = await reader.open(entry!);
      consumed = buffer(stream);
      void consumed.catch(() => undefined);
      await sliceRead.reached(consumed, "slice read");
      let closed = false;
      const closing = reader.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      sliceRead.release();
      await closing;
      expect(stream.closed).toBe(true);
    } finally {
      sliceRead.release();
      try {
        await reader.close();
      } finally {
        await consumed?.catch(() => undefined);
        reads?.mockRestore();
        await source.handle.close();
      }
    }
  });

  it("keeps descriptor closure retryable after retiring its slice", async () => {
    const fixture = await sliceOwnershipFixture();
    const reader = new MachOSliceArtifactReader(
      fixture.path,
      {},
      fixture.runner,
    );
    const [entry] = await sliceEntries(reader);
    const stream = await reader.open(entry!);
    const failure = new Error("Mach-O descriptor close denied");
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockRejectedValueOnce(failure);
    try {
      await expect(reader.close()).rejects.toBe(failure);
      expect(stream.closed).toBe(true);
      await reader.close();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
      await reader.close();
    }
  });

  it.runIf(process.platform === "darwin")(
    "retires a slice discovered by the installed lipo",
    async () => {
      const fixture = await sliceOwnershipFixture();
      const reader = new MachOSliceArtifactReader(fixture.path, process.env);
      try {
        const [entry] = await sliceEntries(reader);
        const stream = await reader.open(entry!);
        await once(stream, "readable");
        await reader.close();
        expect(stream.closed).toBe(true);
        expect(reader.provenance()).toMatchObject([
          { tool: "lipo", exit_code: 0 },
        ]);
      } finally {
        await reader.close();
      }
    },
  );
});

it("joins Mach-O structural enumeration reads admitted before close", async () => {
  const fixture = await sliceOwnershipFixture();
  const source = await openRegularFile(fixture.path, { symlinks: "reject" });
  const events: ("read" | "cleanup")[] = [];
  const reader = new MachOSliceArtifactReader(
    fixture.path,
    {},
    {
      ...fixture.runner,
      retryCleanup: async () => {
        events.push("cleanup");
        return [];
      },
    },
    source,
  );
  const enumerationRead = phaseGate();
  const nativeRead = source.handle.read.bind(source.handle);
  const reads = vi.spyOn(source.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    await enumerationRead.hold();
    const result = await Reflect.apply(nativeRead, source.handle, args);
    events.push("read");
    return result;
  }) as typeof source.handle.read);
  const traversal = reader.entries()[Symbol.asyncIterator]();
  const next = traversal.next();
  try {
    await enumerationRead.reached(next, "slice enumeration read");
    const closing = reader.close();
    enumerationRead.release();
    await expect(next).rejects.toMatchObject({ reason: "unavailable" });
    await closing;
    expect(events).toContain("read");
    expect(events.at(-1)).toBe("cleanup");
  } finally {
    enumerationRead.release();
    await next.catch(() => undefined);
    await reader.close();
    reads.mockRestore();
    await source.handle.close();
  }
});

it.each([
  ["cancel", false],
  ["cancel", true],
  ["close", false],
] as const)(
  "refuses to complete a paused slice enumeration after %s (more slices: %s)",
  async (action, moreSlices) => {
    const fixture = await sliceOwnershipFixture(moreSlices);
    const reader = new MachOSliceArtifactReader(
      fixture.path,
      {},
      fixture.runner,
    );
    const caller = new AbortController();
    const reason = { stage: "after final slice" };
    const traversal = reader.entries(caller.signal)[Symbol.asyncIterator]();
    try {
      expect((await traversal.next()).done).toBe(false);
      if (action === "cancel") caller.abort(reason);
      else await reader.close();
      const failure: unknown = await traversal.next().then(
        () => {
          throw new Error("Expected paused enumeration to fail");
        },
        (cause: unknown) => cause,
      );
      expect(failure).toMatchObject({
        reason: action === "cancel" ? "cancelled" : "unavailable",
      });
      if (action === "cancel") expect((failure as Error).cause).toBe(reason);
    } finally {
      await reader.close();
    }
  },
);
