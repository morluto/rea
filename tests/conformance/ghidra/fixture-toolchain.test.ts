import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { requireLaneToolchain } from "./fixture-toolchain.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A stand-in command that prints `banner` for --version and accepts anything else. */
const command = async (directory: string, name: string, banner: string) => {
  const path = join(directory, name);
  await writeFile(
    path,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${banner}\n`)});\n`,
  );
  await chmod(path, 0o700);
  return path;
};

it.skipIf(process.platform === "win32")(
  "names every missing fixture command and the variable that selects it",
  async () => {
    const directory = await createTestTempDirectory("rea-fixture-toolchain-");
    vi.stubEnv("REA_PPC_CLANG", join(directory, "missing-clang"));
    vi.stubEnv(
      "REA_PPC_READELF",
      await command(directory, "readelf", "LLVM readelf 19"),
    );

    const refusal = await requireLaneToolchain("ppc").catch(
      (cause: unknown) => cause,
    );

    expect(refusal).toBeInstanceOf(Error);
    const lines = (refusal as Error).message.split("\n");
    expect(lines[0]).toBe(
      "Missing prerequisite: the ppc lane's fixture toolchain (no workspace was created).",
    );
    expect(lines.slice(1)).toEqual([
      `- REA_PPC_CLANG=${join(directory, "missing-clang")} must generate and link powerpc-unknown-linux-gnu code with -fuse-ld=lld: command not found`,
      `- REA_PPC_READELF=${join(directory, "readelf")} must report /^GNU readelf\\b/u: --version reported "LLVM readelf 19"`,
      "Install the missing commands, or set each variable to a command that provides it.",
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "admits a lane whose commands all answer",
  async () => {
    const directory = await createTestTempDirectory("rea-fixture-toolchain-");
    vi.stubEnv("REA_MIPS_AS", await command(directory, "as", "GNU assembler"));
    vi.stubEnv("REA_MIPS_LD", await command(directory, "ld", "GNU ld"));
    vi.stubEnv("REA_MIPS_READELF", await command(directory, "readelf", "x"));

    await expect(requireLaneToolchain("mips-shared")).resolves.toBeUndefined();
  },
);
