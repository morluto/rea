import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { importVerifierSource } from "../../../scripts/lib/verifier-source-loader.mjs";

/**
 * Build a source-owned freestanding armhf ELF (ARMv7-A, EABI5, hard float)
 * containing both ARM-mode and Thumb-mode probes. Never execute its code.
 */
export async function buildArmFixture(directory, commands) {
  if (typeof commands?.exec !== "function")
    throw new TypeError("ARM fixture builds require an owned command runner");
  const compiler = process.env.REA_ARM_CLANG ?? "clang";
  const target = "arm-linux-gnueabihf";
  const source = fileURLToPath(new URL("../c/arm.c", import.meta.url));
  const probe = fileURLToPath(new URL("./arm-probe.S", import.meta.url));
  const path = join(directory, `${target}.elf`);
  const args = [
    `--target=${target}`,
    "-march=armv7-a+fp",
    "-mfpu=vfpv3",
    "-mfloat-abi=hard",
    "-fno-pic",
    "-fuse-ld=lld",
    "-nostdlib",
    "-static",
    "-O0",
    "-g",
    "-Wl,-e,rea_arm_entry",
    "-Wl,--build-id=none",
    source,
    probe,
    "-o",
    path,
  ];
  const version = await commands.exec(compiler, ["--version"], {
    timeout: 10000,
  });
  await commands.exec(compiler, args, { timeout: 60000 });
  const bytes = await readFile(path);
  const { BinaryReader } = await importVerifierSource(
    new URL("../../../src/domain/binaryContainer.ts", import.meta.url).href,
    import.meta.url,
  );
  const reader = new BinaryReader(bytes, true, "elf");
  const flags = reader.u32(36);
  if (
    bytes.length < 52 ||
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 1 ||
    bytes[5] !== 1 ||
    reader.u16(16) !== 2 ||
    reader.u16(18) !== 40 ||
    (flags & 0xff000000) !== 0x05000000 ||
    (flags & 0x400) === 0
  )
    throw new Error(
      "Compiler did not produce the declared ELF32/LE/ET_EXEC/EABI5/hard-float armhf fixture",
    );
  return {
    path,
    flags,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source_sha256: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    probe_sha256: createHash("sha256")
      .update(await readFile(probe))
      .digest("hex"),
    compiler: version.stdout.trim(),
    arguments: args,
  };
}
