import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { FIXTURE_TOOLS, fixtureCommand } from "./fixture-toolchain.mjs";
import { buildLoongArchFixture } from "./loongarch-fixture.mjs";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** A minimal ELF64 little-endian LoongArch header, enough for the fixture's own checks. */
const loongarchElf64 = (type: 2 | 3, flags: number) => {
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x7f;
  bytes.write("ELF", 1);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(258, 18);
  bytes.writeUInt32LE(flags, 48);
  return bytes;
};

describe("LoongArch fixture command ownership", () => {
  it("builds both images through the supplied runner and keeps the old-world copy local", async () => {
    const directory = await createTestTempDirectory("rea-loongarch-fixture-");
    const tool = FIXTURE_TOOLS.loongarchGcc;
    if (tool === undefined) throw new TypeError("loongarchGcc");
    const compiler = fixtureCommand(tool);
    const calls: {
      command: string;
      args: readonly string[];
      timeout: number | undefined;
    }[] = [];
    const fixture = await buildLoongArchFixture(directory, {
      async exec(
        command: string,
        args: readonly string[],
        options?: { timeout?: number },
      ) {
        calls.push({ command, args, timeout: options?.timeout });
        if (args[0] === "--version")
          return { stdout: "runner-version\n", stderr: "" };
        const output = args[args.indexOf("-o") + 1];
        if (output === undefined) throw new TypeError("missing output path");
        await writeFile(
          output,
          loongarchElf64(args.includes("-shared") ? 3 : 2, 0x43),
        );
        return { stdout: "", stderr: "" };
      },
    });

    expect(calls.map((call) => call.command)).toEqual([
      compiler,
      compiler,
      compiler,
    ]);
    expect(calls[0]).toEqual({
      command: compiler,
      args: ["--version"],
      timeout: 10000,
    });
    expect(calls[1]?.timeout).toBe(120000);
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining([
        "-fPIC",
        "-shared",
        "-nostdlib",
        "-o",
        join(directory, "loongarch.so"),
      ]),
    );
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining([
        "-static",
        "-ffreestanding",
        "-Wl,-e,rea_loongarch_probe",
        "-o",
        join(directory, "loongarch.elf"),
      ]),
    );
    expect(fixture).toMatchObject({
      compiler: "runner-version",
      shared: {
        path: join(directory, "loongarch.so"),
        flags: 0x43,
      },
      executable: {
        path: join(directory, "loongarch.elf"),
        flags: 0x43,
      },
      // Only the copied e_flags changes; no compiler run produces it.
      old_world: {
        path: join(directory, "loongarch-old-world.so"),
        flags: 0x3,
      },
      arguments: { shared: calls[1]?.args, executable: calls[2]?.args },
    });
    const oldWorld = await readFile(fixture.old_world.path);
    expect(oldWorld.readUInt32LE(48)).toBe(0x3);
    expect(sha256(oldWorld)).toBe(fixture.old_world.sha256);
  });

  it.each([
    ["omitted", undefined],
    ["empty", {}],
    ["non-function", { exec: "gcc" }],
  ] as const)(
    "rejects a %s command runner with TypeError",
    async (_label, commands) => {
      const directory = await createTestTempDirectory("rea-loongarch-fixture-");
      await expect(
        buildLoongArchFixture(directory, commands),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );
});
