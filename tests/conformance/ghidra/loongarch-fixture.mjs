import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** `EF_LARCH_OBJABI_V1`; clearing it declares the old-world object ABI v0. */
const OBJABI_V1 = 0x40;
const EM_LOONGARCH = 258;

const source = fileURLToPath(new URL("../c/loongarch.c", import.meta.url));
const probe = fileURLToPath(new URL("./loongarch-probe.S", import.meta.url));
const commonArguments = ["-O2", "-Wl,--build-id=none", "-Wl,--hash-style=sysv"];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Build source-owned LoongArch ELF fixtures: one shared object (`ET_DYN`) and
 * one fixed-address executable (`ET_EXEC`). The compiler's declarations are
 * checked, then a copy of the shared object declares the old-world object ABI
 * by clearing `EF_LARCH_OBJABI_V1`; only that ELF element changes, so the
 * instruction bytes remain the new-world toolchain's output. No fixture code
 * is executed.
 */
export async function buildLoongArchFixture(directory) {
  const compiler = process.env.REA_LOONGARCH_GCC ?? "loongarch64-linux-gnu-gcc";
  const version = await execute(compiler, ["--version"], { timeout: 10000 });
  const compile = async (name, arguments_) => {
    const path = join(directory, name);
    const args = [...commonArguments, ...arguments_, source, probe, "-o", path];
    await execute(compiler, args, { timeout: 120000 });
    const bytes = await readFile(path);
    return { path, bytes, args };
  };

  const shared = await compile("loongarch.so", [
    "-fPIC",
    "-shared",
    "-nostdlib",
  ]);
  const executable = await compile("loongarch.elf", [
    "-static",
    "-nostdlib",
    "-ffreestanding",
    "-Wl,-e,rea_loongarch_probe",
  ]);
  assertLoongArchHeader(shared.bytes, 3);
  assertLoongArchHeader(executable.bytes, 2);
  assert.equal(
    shared.bytes.readUInt32LE(48),
    0x43,
    "Fixture compiler did not declare LP64D new-world e_flags",
  );
  assert.equal(
    executable.bytes.readUInt32LE(48),
    0x43,
    "Fixture compiler did not declare LP64D new-world e_flags",
  );

  const oldWorldBytes = Buffer.from(shared.bytes);
  oldWorldBytes.writeUInt32LE(oldWorldBytes.readUInt32LE(48) & ~OBJABI_V1, 48);
  assertLoongArchHeader(oldWorldBytes, 3);
  assert.equal(
    oldWorldBytes.readUInt32LE(48),
    0x3,
    "Old-world fixture declaration was not applied",
  );
  const oldWorldPath = join(directory, "loongarch-old-world.so");
  await writeFile(oldWorldPath, oldWorldBytes);

  return {
    compiler: version.stdout.trim(),
    arguments: {
      shared: shared.args,
      executable: executable.args,
      old_world: "shared fixture with EF_LARCH_OBJABI_V1 cleared",
    },
    shared: {
      path: shared.path,
      sha256: digest(shared.bytes),
      flags: shared.bytes.readUInt32LE(48),
      source_sha256: digest(await readFile(source)),
      probe_sha256: digest(await readFile(probe)),
    },
    executable: {
      path: executable.path,
      sha256: digest(executable.bytes),
      flags: executable.bytes.readUInt32LE(48),
    },
    old_world: {
      path: oldWorldPath,
      sha256: digest(oldWorldBytes),
      flags: oldWorldBytes.readUInt32LE(48),
    },
  };
}

/** Only the documented ELF64 little-endian LoongArch header is admitted here. */
function assertLoongArchHeader(bytes, type) {
  assert.ok(bytes.length >= 64, "Fixture is not a complete ELF64 header");
  assert.equal(bytes.toString("hex", 0, 4), "7f454c46");
  assert.equal(bytes[4], 2, "Fixture is not ELF64");
  assert.equal(bytes[5], 1, "Fixture is not little-endian");
  assert.equal(bytes.readUInt16LE(16), type, "Unexpected fixture e_type");
  assert.equal(bytes.readUInt16LE(18), EM_LOONGARCH, "Unexpected e_machine");
}
