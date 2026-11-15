import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { requireLaneToolchain } from "./fixture-toolchain.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A stand-in command that prints `banner` for any arguments. */
const command = async (directory: string, name: string, banner: string) => {
  const path = join(directory, name);
  await writeFile(
    path,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${banner}\n`)});\n`,
  );
  await chmod(path, 0o700);
  return path;
};

/** The refusal's lines that name `selected` (a `VARIABLE=command` pair). */
const refusalFor = async (lane: string, selected: string) => {
  const refusal = await requireLaneToolchain(lane).catch(
    (cause: unknown) => cause,
  );
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toMatch(/^Missing prerequisite\b/u);
  return (refusal as Error).message
    .split("\n")
    .filter((line) => line.includes(selected));
};

const mipsBinutils = async (directory: string, target: string) => {
  vi.stubEnv(
    "REA_MIPS_AS",
    await command(
      directory,
      "as",
      `GNU assembler (GNU Binutils) 2.44\nThis assembler was configured for a target of \`${target}'.`,
    ),
  );
  vi.stubEnv(
    "REA_MIPS_LD",
    await command(
      directory,
      "ld",
      `GNU ld (GNU Binutils) 2.44\n  Supported emulations:\n   ${target.startsWith("mips") ? "elf32btsmip" : "elf_x86_64"}`,
    ),
  );
  vi.stubEnv("REA_MIPS_READELF", await command(directory, "readelf", "x"));
};

it.skipIf(process.platform === "win32")(
  "names each missing fixture command, its variable and the observed reason",
  async () => {
    const directory = await createTestTempDirectory("rea-fixture-toolchain-");
    const clang = join(directory, "missing-clang");
    const readelf = await command(directory, "readelf", "LLVM readelf 19");
    vi.stubEnv("REA_PPC_CLANG", clang);
    vi.stubEnv("REA_PPC_READELF", readelf);

    const [compiler] = await refusalFor("ppc", `REA_PPC_CLANG=${clang}`);
    expect(compiler).toContain("powerpc-unknown-linux-gnu");
    expect(compiler).toContain("command not found");
    const [reader] = await refusalFor("ppc", `REA_PPC_READELF=${readelf}`);
    expect(reader).toContain("LLVM readelf 19");
  },
);

it.skipIf(process.platform === "win32")(
  "admits MIPS binutils configured for MIPS and refuses host-native ones",
  async () => {
    const directory = await createTestTempDirectory("rea-fixture-toolchain-");
    await mipsBinutils(directory, "mips-linux-gnu");
    await expect(requireLaneToolchain("mips-shared")).resolves.toBeUndefined();

    const native = await createTestTempDirectory("rea-fixture-toolchain-");
    await mipsBinutils(native, "x86_64-linux-gnu");
    expect(
      await refusalFor("mips-shared", `REA_MIPS_AS=${join(native, "as")}`),
    ).toHaveLength(1);
    expect(
      await refusalFor("mips-shared", `REA_MIPS_LD=${join(native, "ld")}`),
    ).toHaveLength(1);
  },
);
