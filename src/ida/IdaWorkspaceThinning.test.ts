import { createHash } from "node:crypto";
import { open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import { parseExecutableHeader } from "../domain/binaryTarget.js";
import { fat, thinMach } from "../domain/binaryTarget.fixture.js";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { IdaWorkspace } from "./IdaWorkspace.js";

interface BufferWritePrototype {
  write(
    buffer: Buffer,
    offset?: number,
    length?: number,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const resolveUniversalTarget = async (
  bytes: Buffer,
  hostArchitecture: "arm64" | "x64",
) => {
  const directory = await createTestTempDirectory("rea-ida-thin-");
  const path = join(directory, "universal");
  await writeFile(path, bytes);
  const resolved = await parseBinaryTarget(path, { hostArchitecture });
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.format !== "mach-o-universal")
    throw new Error("the universal fixture did not resolve as a FAT container");
  return { bytes, target: resolved.value };
};

/** Write a two-slice universal fixture and resolve it for the given host. */
const universalTarget = (hostArchitecture: "arm64" | "x64") =>
  resolveUniversalTarget(fat([0x01000007, 0x0100000c]), hostArchitecture);

/** One slice of a synthetic universal file: CPU type, offset and size. */
interface Layout {
  readonly cpu: number;
  readonly offset: number;
  readonly size: number;
  readonly alignmentExponent?: number;
}

const multiSliceLayout: readonly Layout[] = [
  { cpu: 0x01000007, offset: 4096, size: 8480, alignmentExponent: 12 },
  { cpu: 0x0100000c, offset: 16384, size: 33464 },
  { cpu: 0x00000007, offset: 65536, size: 33464 },
];

/**
 * Write a universal file whose slices span more than one 64 KiB read, each
 * filled with its own byte so bytes outside the selected slice are visible.
 */
const largeUniversalTarget = async (
  layout: readonly Layout[],
  hostArchitecture: "arm64" | "x64",
) => {
  const total = Math.max(...layout.map(({ offset, size }) => offset + size));
  const bytes = Buffer.alloc(total);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(layout.length, 4);
  layout.forEach(({ cpu, offset, size, alignmentExponent = 14 }, index) => {
    const entry = 8 + index * 20;
    bytes.writeUInt32BE(cpu, entry);
    bytes.writeUInt32BE(offset, entry + 8);
    bytes.writeUInt32BE(size, entry + 12);
    bytes.writeUInt32BE(alignmentExponent, entry + 16);
    bytes.fill(0x11 * (index + 1), offset, offset + size);
    thinMach(0xfeedfacf, cpu).copy(bytes, offset);
  });
  return await resolveUniversalTarget(bytes, hostArchitecture);
};

describe("IDA workspace input thinning", () => {
  it("admits the multi-read FAT fixture on every host platform", async () => {
    const { target } = await largeUniversalTarget(multiSliceLayout, "arm64");
    expect(target.universalSlice).toMatchObject({ offset: 16384, size: 33464 });
  });

  it.skipIf(process.platform === "win32").each([
    {
      host: "arm64",
      architecture: "arm64",
      layout: multiSliceLayout,
      offset: 16384,
      size: 33464,
    },
    {
      host: "x64",
      architecture: "x86_64",
      layout: [
        { cpu: 0x01000007, offset: 16384, size: 37456 },
        { cpu: 0x0100000c, offset: 65536, size: 33464 },
      ],
      offset: 16384,
      size: 37456,
    },
  ] as const)(
    "copies only the selected $architecture slice across reads",
    async ({ host, architecture, layout, offset, size }) => {
      const { bytes, target } = await largeUniversalTarget(layout, host);
      expect(target.universalSlice).toMatchObject({ offset, size });
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      await workspace.copyInput();
      const input = await readFile(workspace.inputPath);
      expect(input.equals(bytes.subarray(offset, offset + size))).toBe(true);
      expect(workspace.inputSha256).toBe(
        createHash("sha256").update(input).digest("hex"),
      );
      expect(parseExecutableHeader(input, host)).toMatchObject({
        ok: true,
        value: { format: "mach-o", architecture },
      });
      await workspace.remove();
    },
  );

  it("keeps a whole-file copy for thin targets", async () => {
    const { root, target } = await createIdaTarget("arm64");
    roots.push(root);
    const workspace = await IdaWorkspace.allocate(target, root);
    roots.push(workspace.directory);
    await workspace.copyInput();

    const input = await readFile(workspace.inputPath);
    const source = await readFile(target.path);
    expect(input.equals(source)).toBe(true);
    expect(workspace.inputSha256).toBe(target.sha256);
    await workspace.remove();
  });
});

describe("IDA workspace write completion", () => {
  it.each(["thin", "universal"] as const)(
    "completes short writes before recording the %s input digest",
    async (kind) => {
      const selected =
        kind === "thin"
          ? await createIdaTarget("arm64")
          : await universalTarget("arm64");
      if ("root" in selected) roots.push(selected.root);
      const { target } = selected;
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      const probe = await open(target.path, "r");
      const prototype = Object.getPrototypeOf(probe) as BufferWritePrototype;
      const originalWrite = prototype.write;
      await probe.close();
      const write = vi.spyOn(prototype, "write").mockImplementation(function (
        this: unknown,
        buffer: Buffer,
        offset = 0,
        length = buffer.length,
      ) {
        return Reflect.apply(originalWrite, this, [
          buffer,
          offset,
          Math.min(length, 7),
        ]);
      });
      await workspace.copyInput();
      write.mockRestore();
      const input = await readFile(workspace.inputPath);
      const source = await readFile(target.path);
      const slice =
        target.format === "mach-o-universal"
          ? target.universalSlice
          : undefined;
      expect(
        input.equals(
          slice === undefined
            ? source
            : source.subarray(slice.offset, slice.offset + slice.size),
        ),
      ).toBe(true);
      expect(workspace.inputSha256).toBe(
        createHash("sha256").update(input).digest("hex"),
      );
      await workspace.remove();
    },
  );

  it("rejects a zero-progress write without publishing an input digest", async () => {
    const { root, target } = await createIdaTarget("arm64");
    roots.push(root);
    const workspace = await IdaWorkspace.allocate(target);
    roots.push(workspace.directory);
    const probe = await open(target.path, "r");
    const prototype = Object.getPrototypeOf(probe) as BufferWritePrototype;
    await probe.close();
    const write = vi
      .spyOn(prototype, "write")
      .mockResolvedValue({ bytesWritten: 0, buffer: Buffer.alloc(0) });
    await expect(workspace.copyInput()).rejects.toThrow(
      "write made no progress",
    );
    write.mockRestore();
    expect(workspace.inputSha256).toBeUndefined();
    await workspace.remove();
  });
});

describe("IDA workspace admission identity", () => {
  it.skipIf(process.platform === "win32")(
    "rejects a universal source changed outside the selected slice after admission",
    async () => {
      const { bytes, target } = await largeUniversalTarget(
        multiSliceLayout,
        "arm64",
      );
      // This byte belongs to the unselected x86_64 slice.
      bytes.writeUInt8(0x77, 4096 + 40);
      await writeFile(target.path, bytes);
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      await expect(workspace.copyInput()).rejects.toThrow("target changed");
      expect(workspace.inputSha256).toBeUndefined();
      await workspace.remove();
    },
  );

  it("binds a headless session to the thinned input identity", async () => {
    const { target } = await universalTarget("arm64");
    const root = await createTestTempDirectory("rea-ida-thin-root-");
    const producer = new RecordingIdaMcp(target, "headless");
    const client = new IdaSessionClient(
      {
        command: "fixture",
        args: [],
        env: {},
        mode: "headless",
        protocol: "modern",
        timeoutMs: 1000,
        workspaceRoot: root,
      },
      target,
      producer,
    );
    expect((await client.execute("health", {})).ok).toBe(true);
    const open = producer.calls.find(({ name }) => name === "idb_open");
    expect(String(open?.args.input_path)).toContain("universal");
    expect((await client.close()).ok).toBe(true);
  });

  it("verifies unchanged private inputs via stat and falls back to digest on metadata or content change", async () => {
    const { root, target } = await createIdaTarget("arm64");
    roots.push(root);
    const workspace = await IdaWorkspace.allocate(target);
    roots.push(workspace.directory);
    expect(await workspace.verifyInputUnchanged()).toBe(false);
    await workspace.copyInput();
    expect(await workspace.verifyInputUnchanged()).toBe(true);
    // Touching timestamps forces the fallback full-file digest, which still passes on identical bytes.
    const bumped = new Date(Date.now() + 5_000);
    await utimes(workspace.inputPath, bumped, bumped);
    expect(await workspace.verifyInputUnchanged()).toBe(true);
    // Modifying the private input bytes is detected and refused.
    const original = await readFile(workspace.inputPath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    await writeFile(workspace.inputPath, tampered);
    expect(await workspace.verifyInputUnchanged()).toBe(false);
    await workspace.remove();
  });
});
