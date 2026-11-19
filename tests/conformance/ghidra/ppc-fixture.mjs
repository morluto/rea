import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FIXTURE_TOOLS, fixtureCommand } from "./fixture-toolchain.mjs";

const execute = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Link one source-owned C file and probe; never execute the target code. */
async function buildFixture(directory, { target, options, entry, sources }) {
  const compiler = fixtureCommand(FIXTURE_TOOLS.ppcClang);
  const [source, probe] = sources.map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const path = join(directory, `${target}.elf`);
  const args = [
    `--target=${target}`,
    ...options,
    "-fno-pic",
    "-fuse-ld=lld",
    "-nostdlib",
    "-static",
    "-O0",
    "-g",
    `-Wl,-e,${entry}`,
    "-Wl,--build-id=none",
    source,
    probe,
    "-o",
    path,
  ];
  const version = await execute(compiler, ["--version"], { timeout: 10000 });
  await execute(compiler, args, { timeout: 60000 });
  const bytes = await readFile(path);
  return {
    bytes,
    fixture: {
      path,
      sha256: sha256(bytes),
      source_sha256: sha256(await readFile(source)),
      probe_sha256: sha256(await readFile(probe)),
      compiler: version.stdout.trim(),
      arguments: args,
    },
  };
}

/** Build a source-owned freestanding ELF; never execute its target code. */
export async function buildPowerPcFixture(directory) {
  const { bytes, fixture } = await buildFixture(directory, {
    target: "powerpc-unknown-linux-gnu",
    // A 750-family core with the classic FPU, unlike the e500 SPE variant.
    options: ["-mcpu=750"],
    entry: "rea_ppc_entry",
    sources: ["../c/ppc.c", "./ppc-probe.S"],
  });
  if (
    bytes.length < 52 ||
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 1 ||
    bytes[5] !== 2 ||
    bytes.readUInt16BE(16) !== 2 ||
    bytes.readUInt16BE(18) !== 20 ||
    bytes.readUInt32BE(36) !== 0
  )
    throw new Error(
      "Compiler did not produce the declared ELF32 big-endian PowerPC fixture",
    );
  return { ...fixture, flags: bytes.readUInt32BE(36) };
}

/**
 * Build the source-owned ELFv2 PPC64 executable for one byte order. Clang's
 * big-endian Linux default is ELFv1, so the ABI is requested explicitly.
 */
export async function buildPowerPc64Fixture(directory, byteOrder) {
  const little = byteOrder === "little";
  const { bytes, fixture } = await buildFixture(directory, {
    target: little
      ? "powerpc64le-unknown-linux-gnu"
      : "powerpc64-unknown-linux-gnu",
    // A POWER9 core, so the VSX probe instruction is part of the target ISA.
    options: ["-mcpu=power9", "-mabi=elfv2"],
    entry: "rea_ppc64_entry",
    sources: ["../c/ppc64.c", "./ppc64-probe.S"],
  });
  const u16 = (offset) =>
    little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const flags =
    bytes.length < 64
      ? undefined
      : little
        ? bytes.readUInt32LE(48)
        : bytes.readUInt32BE(48);
  if (
    flags !== 2 ||
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== (little ? 1 : 2) ||
    u16(16) !== 2 ||
    u16(18) !== 21
  )
    throw new Error(
      `Compiler did not produce the declared ELF64 ${byteOrder}-endian ELFv2 PowerPC fixture`,
    );
  return { ...fixture, byte_order: byteOrder, flags };
}
