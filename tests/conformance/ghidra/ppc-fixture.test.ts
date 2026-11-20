import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { FIXTURE_TOOLS, fixtureCommand } from "./fixture-toolchain.mjs";
import { buildPowerPc64Fixture } from "./ppc-fixture.mjs";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const elf64 = (byteOrder: "little" | "big") => {
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x7f;
  bytes.write("ELF", 1);
  bytes[4] = 2;
  bytes[5] = byteOrder === "little" ? 1 : 2;
  if (byteOrder === "little") {
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(21, 18);
    bytes.writeUInt32LE(2, 48);
  } else {
    bytes.writeUInt16BE(2, 16);
    bytes.writeUInt16BE(21, 18);
    bytes.writeUInt32BE(2, 48);
  }
  return bytes;
};

describe("PPC64 fixture command ownership", () => {
  it.each(["little", "big"] as const)(
    "builds the %s-endian ELFv2 header through the supplied runner",
    async (byteOrder) => {
      const directory = await createTestTempDirectory("rea-ppc64-fixture-");
      const image = elf64(byteOrder);
      const calls: {
        command: string;
        args: readonly string[];
        timeout: number | undefined;
      }[] = [];
      const tool = FIXTURE_TOOLS.ppcClang;
      if (tool === undefined) throw new TypeError("ppcClang");
      const compiler = fixtureCommand(tool);
      const target =
        byteOrder === "little"
          ? "powerpc64le-unknown-linux-gnu"
          : "powerpc64-unknown-linux-gnu";
      const fixture = await buildPowerPc64Fixture(directory, byteOrder, {
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
          await writeFile(output, image);
          return { stdout: "", stderr: "" };
        },
      });
      expect(calls.map((call) => call.command)).toEqual([compiler, compiler]);
      expect(calls[0]).toEqual({
        command: compiler,
        args: ["--version"],
        timeout: 10000,
      });
      expect(calls[1]?.timeout).toBe(60000);
      expect(calls[1]?.args).toEqual(
        expect.arrayContaining([
          `--target=${target}`,
          "-mcpu=power9",
          "-mabi=elfv2",
          "-Wl,-e,rea_ppc64_entry",
          "-o",
          join(directory, `${target}.elf`),
        ]),
      );
      expect(fixture).toMatchObject({
        path: join(directory, `${target}.elf`),
        byte_order: byteOrder,
        flags: 2,
        sha256: sha256(image),
        source_sha256: sha256(
          await readFile(
            fileURLToPath(new URL("../c/ppc64.c", import.meta.url)),
          ),
        ),
        probe_sha256: sha256(
          await readFile(
            fileURLToPath(new URL("./ppc64-probe.S", import.meta.url)),
          ),
        ),
        compiler: "runner-version",
        arguments: calls[1]?.args,
      });
    },
  );

  it.each([
    ["omitted", undefined],
    ["empty", {}],
    ["non-function", { exec: "clang" }],
  ] as const)(
    "rejects a %s command runner with TypeError",
    async (_label, commands) => {
      const directory = await createTestTempDirectory("rea-ppc64-fixture-");
      await expect(
        buildPowerPc64Fixture(directory, "little", commands),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );
});
