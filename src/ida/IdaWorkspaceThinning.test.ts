import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Write a two-slice universal fixture and resolve it for the given host. */
const universalTarget = async (hostArchitecture: "arm64" | "x64") => {
  const directory = await createTestTempDirectory("rea-ida-thin-");
  roots.push(directory);
  const path = join(directory, "universal");
  const bytes = fat([0x01000007, 0x0100000c]);
  await writeFile(path, bytes);
  const resolved = await parseBinaryTarget(path, { hostArchitecture });
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.format !== "mach-o-universal")
    throw new Error("the universal fixture did not resolve as a FAT container");
  return { bytes, target: resolved.value };
};

/** One slice of a synthetic universal file: CPU type, offset and size. */
interface Layout {
  readonly cpu: number;
  readonly offset: number;
  readonly size: number;
  readonly alignmentExponent?: number;
}

/**
 * Write a universal file whose slices span more than one 64 KiB read, each
 * filled with its own byte so bytes outside the selected slice are visible.
 */
const largeUniversalTarget = async (
  layout: readonly Layout[],
  hostArchitecture: "arm64" | "x64",
) => {
  const directory = await createTestTempDirectory("rea-ida-thin-large-");
  roots.push(directory);
  const path = join(directory, "universal");
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
  await writeFile(path, bytes);
  const resolved = await parseBinaryTarget(path, { hostArchitecture });
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.format !== "mach-o-universal")
    throw new Error("the universal fixture did not resolve as a FAT container");
  return { bytes, target: resolved.value };
};

describe("IDA workspace input thinning", () => {
  it.skipIf(process.platform === "win32")(
    "thins the selected arm64 slice into the private headless input",
    async () => {
      const { bytes, target } = await universalTarget("arm64");
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      await workspace.copyInput();

      const input = await readFile(workspace.inputPath);
      const { offset, size } = target.universalSlice;
      expect(offset).toBeGreaterThan(0);
      expect(input.equals(bytes.subarray(offset, offset + size))).toBe(true);
      expect(input.length).toBe(size);
      expect(input.readUInt32BE(0)).toBe(0xfeedfacf);
      expect(input.readUInt32BE(4)).toBe(0x0100000c);
      expect(parseExecutableHeader(input, "arm64")).toMatchObject({
        ok: true,
        value: { format: "mach-o", architecture: "arm64" },
      });
      expect(createHash("sha256").update(input).digest("hex")).toBe(
        workspace.inputSha256,
      );
      await workspace.remove();
    },
  );

  it.skipIf(process.platform === "win32")(
    "thins the x86_64 slice when the host is intel",
    async () => {
      const { bytes, target } = await universalTarget("x64");
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      await workspace.copyInput();

      const input = await readFile(workspace.inputPath);
      const { offset, size } = target.universalSlice;
      expect(input.equals(bytes.subarray(offset, offset + size))).toBe(true);
      expect(input.readUInt32BE(4)).toBe(0x01000007);
      await workspace.remove();
    },
  );

  it.skipIf(process.platform === "win32")(
    "copies exactly the selected slice when later slices follow it across read boundaries",
    async () => {
      const { bytes, target } = await largeUniversalTarget(
        [
          {
            cpu: 0x01000007,
            offset: 4096,
            size: 8480,
            alignmentExponent: 12,
          },
          { cpu: 0x0100000c, offset: 16384, size: 33464 },
          { cpu: 0x00000007, offset: 65536, size: 33464 },
        ],
        "arm64",
      );
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      await workspace.copyInput();

      const input = await readFile(workspace.inputPath);
      const { offset, size } = target.universalSlice;
      expect(size, "the arm64 slice is selected").toBe(33464);
      expect(input.length, "no byte after the slice is copied").toBe(size);
      expect(input.equals(bytes.subarray(offset, offset + size))).toBe(true);
      expect(workspace.inputSha256).toBe(
        createHash("sha256")
          .update(bytes.subarray(offset, offset + size))
          .digest("hex"),
      );
      await workspace.remove();
    },
  );

  it.skipIf(process.platform === "win32")(
    "copies exactly the first slice when it is selected and others follow",
    async () => {
      const { bytes, target } = await largeUniversalTarget(
        [
          { cpu: 0x01000007, offset: 16384, size: 37456 },
          { cpu: 0x0100000c, offset: 65536, size: 33464 },
        ],
        "x64",
      );
      const workspace = await IdaWorkspace.allocate(target);
      roots.push(workspace.directory);
      await workspace.copyInput();

      const input = await readFile(workspace.inputPath);
      const { offset, size } = target.universalSlice;
      expect(size, "the x86_64 slice is selected").toBe(37456);
      expect(input.length, "no byte after the slice is copied").toBe(size);
      expect(input.equals(bytes.subarray(offset, offset + size))).toBe(true);
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

  it.skipIf(process.platform === "win32")(
    "rejects a universal source that changed after admission",
    async () => {
      const { target } = await universalTarget("arm64");
      const workspace = await IdaWorkspace.allocate({
        ...target,
        sha256: "a".repeat(64),
      });
      roots.push(workspace.directory);
      await expect(workspace.copyInput()).rejects.toThrow("target changed");
      await workspace.remove();
    },
  );

  it("binds a headless session to the thinned input identity", async () => {
    const { target } = await universalTarget("arm64");
    const root = await createTestTempDirectory("rea-ida-thin-root-");
    roots.push(root);
    const producer = new RecordingIdaMcp(target, "headless");
    const client = new IdaSessionClient(
      {
        command: "fixture",
        args: [],
        env: {},
        mode: "headless",
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
});
