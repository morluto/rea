// Independent oracle for annotated Thumb fixtures: LLVM assembles each source
// for its triple, the .text bytes must equal the fixture bytes, and
// llvm-objdump gives the mnemonic at each instruction offset. Data the source
// declares (an ARM `$d` mapping symbol) is not an instruction.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Deadline and per-stream output capacity of each LLVM command. */
const LLVM_COMMAND = { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 };

/** Bytes of the `.text` section of a little-endian ELF32 relocatable object. */
const elf32Text = (object) => {
  assert.equal(
    object.readUInt32BE(0),
    0x7f454c46,
    "assembler output is not ELF",
  );
  assert.equal(object[4], 1, "assembler output is not ELF32");
  assert.equal(object[5], 1, "assembler output is not little-endian");
  const sectionHeaders = object.readUInt32LE(0x20);
  const entrySize = object.readUInt16LE(0x2e);
  const count = object.readUInt16LE(0x30);
  const names = sectionHeaders + object.readUInt16LE(0x32) * entrySize;
  const namesOffset = object.readUInt32LE(names + 0x10);
  for (let index = 0; index < count; index += 1) {
    const header = sectionHeaders + index * entrySize;
    const nameStart = namesOffset + object.readUInt32LE(header);
    const name = object.subarray(nameStart, object.indexOf(0, nameStart));
    if (name.toString("latin1") !== ".text") continue;
    const offset = object.readUInt32LE(header + 0x10);
    return object.subarray(offset, offset + object.readUInt32LE(header + 0x14));
  }
  throw new Error("assembler output has no .text section");
};

/**
 * Assemble `fixture.source` for its triple, and for `fixture.cpu` and
 * `fixture.floatAbi` when it names them, and require its bytes to equal
 * `fixture.code`. Returns LLVM's mnemonic for each instruction, keyed by image
 * offset.
 *
 * `llvm.commands` is the caller's verifier command owner: each tool runs as an
 * owned process tree with a deadline. The files go in a new directory under
 * `llvm.workspace`, which the caller removes after closing that owner.
 */
export const llvmThumbMnemonics = async (fixture, llvm) => {
  const directory = await mkdtemp(join(llvm.workspace, "thumb-oracle-"));
  // Optional extensions such as MVE are enabled by the CPU, not the triple.
  const cpu = (flag) =>
    fixture.cpu === undefined ? [] : [`${flag}=${fixture.cpu}`];
  // clang 19 refuses MVE under the default soft-float ABI.
  const floatAbi =
    fixture.floatAbi === undefined ? [] : [`-mfloat-abi=${fixture.floatAbi}`];
  const source = join(directory, "fixture.s");
  const object = join(directory, "fixture.o");
  await writeFile(source, fixture.source);
  await llvm.commands.exec(
    llvm.clang,
    [
      `--target=${fixture.triple}`,
      ...cpu("-mcpu"),
      ...floatAbi,
      "-c",
      source,
      "-o",
      object,
    ],
    LLVM_COMMAND,
  );
  assert.equal(
    elf32Text(await readFile(object)).toString("hex"),
    fixture.code,
    `LLVM assembles ${fixture.triple} source to different bytes`,
  );
  const { stdout } = await llvm.commands.exec(
    llvm.objdump,
    [
      "-d",
      "--no-show-raw-insn",
      `--triple=${fixture.triple}`,
      ...cpu("--mcpu"),
      object,
    ],
    LLVM_COMMAND,
  );
  const mnemonics = new Map();
  for (const line of stdout.split("\n")) {
    // `offset:` then data bytes, if any, then a tab and the mnemonic or, for
    // data, a directive such as `.short`.
    const match = /^\s*([0-9a-f]+):[^\t]*\t(\.?[a-z][a-z0-9.]*)/u.exec(line);
    if (match !== null && !match[2].startsWith("."))
      mnemonics.set(
        fixture.codeOffset + Number.parseInt(match[1], 16),
        match[2],
      );
  }
  assert.ok(mnemonics.size > 0, "llvm-objdump reported no instructions");
  return mnemonics;
};
