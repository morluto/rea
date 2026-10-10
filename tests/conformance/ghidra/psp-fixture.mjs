import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build the maintained, non-PRX PSPSDK fixture, without executing the target. */
export async function buildPspFixture(directory, globalValue = 7) {
  assert.ok(globalValue === 7 || globalValue === 11);
  const options = {
    cwd: directory,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  };
  const versions = {};
  for (const command of ["make", "psp-gcc", "psp-readelf", "psp-objdump"])
    versions[command] = (
      await execute(command, ["--version"], options)
    ).stdout.trim();
  const sourceDigests = {};
  for (const name of ["main.c", "probe.S", "Makefile"]) {
    const source = new URL(`../psp/${name}`, import.meta.url);
    sourceDigests[name] = sha256(await readFile(source));
    await copyFile(source, join(directory, name));
  }
  const build = await execute(
    "make",
    [`REA_PSP_GLOBAL=${globalValue}`, "rea_psp_fixture.elf"],
    { ...options, timeout: 60000 },
  );
  const path = join(directory, "rea_psp_fixture.elf");
  const bytes = await readFile(path);
  assert.ok(bytes.length >= 52);
  assert.equal(bytes.toString("hex", 0, 6), "7f454c460101");
  assert.equal(bytes.readUInt16LE(16), 2);
  assert.equal(bytes.readUInt16LE(18), 8);
  assert.equal(bytes.readUInt32LE(36), 0x10a23001);
  const readelf = await execute(
    "psp-readelf",
    ["-h", "-A", "-sW", path],
    options,
  );
  assert.equal(readelf.stderr.trim(), "");
  assert.match(readelf.stdout, /Class:\s+ELF32/u);
  assert.match(readelf.stdout, /Data:\s+2's complement, little endian/u);
  assert.match(readelf.stdout, /Type:\s+EXEC\b/u);
  assert.match(readelf.stdout, /Flags:\s+0x10a23001\b/u);
  const abiFlags = parsePspReadelfAbi(readelf.stdout);
  const abiDump = await execute(
    "psp-readelf",
    ["-x", ".MIPS.abiflags", path],
    options,
  );
  assert.equal(abiDump.stderr.trim(), "");
  const abiWords = abiDump.stdout
    .split("\n")
    .filter((line) => /^\s*0x[0-9a-f]+\s/u.test(line))
    .flatMap((line) => line.match(/\b[0-9a-f]{8}\b/gu) ?? []);
  assert.equal(
    abiWords.join(""),
    "000002000101000200000000000000000100000000000000",
    "PSPSDK ABI bytes differ from independently inspected build intent",
  );
  const symbols = {};
  for (const [name, type] of [
    ["rea_psp_entry", "FUNC"],
    ["rea_psp_leaf", "FUNC"],
    ["rea_psp_probe", "FUNC"],
    ["rea_psp_global", "OBJECT"],
    ["rea_psp_marker", "OBJECT"],
  ]) {
    const rows = readelf.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter((row) => row.length === 8 && row[7] === name);
    assert.equal(rows.length, 1, `Expected one defined PSP symbol: ${name}`);
    const row = rows[0];
    assert.match(row[1], /^[0-9a-fA-F]{8}$/u);
    assert.equal(row[3], type);
    assert.equal(row[4], "GLOBAL");
    assert.match(row[6], /^\d+$/u);
    symbols[name] = `0x${Number.parseInt(row[1], 16).toString(16)}`;
  }
  const objdump = await execute(
    "psp-objdump",
    ["-d", "--disassemble=rea_psp_probe", path],
    options,
  );
  assert.equal(objdump.stderr.trim(), "");
  assert.match(objdump.stdout, /\bbitrev\b/u);
  return {
    path,
    sha256: sha256(bytes),
    source_sha256: sourceDigests,
    symbols,
    flags: "0x10a23001",
    mips: {
      elfClass: 32,
      byteOrder: "little",
      type: 2,
      flags: 0x10a23001,
      abiFlags,
    },
    abi_record_hex_dump: abiDump.stdout,
    global_value: globalValue,
    versions,
    readelf: readelf.stdout,
    objdump: objdump.stdout,
    build_stderr: build.stderr,
  };
}

/** Independent GNU fields for the pinned PSPSDK fixture, not REA's parser. */
export function parsePspReadelfAbi(text) {
  const field = (expression, label) => {
    const matches = [...text.matchAll(expression)];
    assert.equal(
      matches.length,
      1,
      `Missing or ambiguous PSP readelf ${label}`,
    );
    return matches[0][1].trim();
  };
  const width = (name) => {
    const bits = Number(
      field(new RegExp(`^${name} size:\\s*(\\d+)\\s*$`, "gmu"), name),
    );
    assert.ok(bits === 0 || bits === 32, `Unverified PSP ${name} width`);
    return bits === 32 ? 1 : 0;
  };
  const isaLevel = Number(field(/^ISA:\s*MIPS(\d+)\s*$/gmu, "ISA"));
  assert.equal(
    field(/^FP ABI:\s*(.+)$/gmu, "FP ABI"),
    "Hard float (single precision)",
  );
  assert.equal(field(/^ISA Extension:\s*(.+)$/gmu, "ISA extension"), "None");
  assert.equal(field(/^ASEs:\s*\n[ \t]*(.+)$/gmu, "ASEs"), "None");
  const abi = {
    version: Number(
      field(/^MIPS ABI Flags Version:\s*(\d+)\s*$/gmu, "ABI version"),
    ),
    isaLevel,
    isaRevision: 0,
    gprSize: width("GPR"),
    cpr1Size: width("CPR1"),
    cpr2Size: width("CPR2"),
    fpAbi: 2,
    isaExtension: 0,
    ases: 0,
    flags1: Number.parseInt(
      field(/^FLAGS 1:\s*([\da-f]+)\s*$/gmu, "flags1"),
      16,
    ),
    flags2: Number.parseInt(
      field(/^FLAGS 2:\s*([\da-f]+)\s*$/gmu, "flags2"),
      16,
    ),
  };
  assert.deepEqual(
    abi,
    {
      version: 0,
      isaLevel: 2,
      isaRevision: 0,
      gprSize: 1,
      cpr1Size: 1,
      cpr2Size: 0,
      fpAbi: 2,
      isaExtension: 0,
      ases: 0,
      flags1: 1,
      flags2: 0,
    },
    "PSPSDK ABI declaration differs from independently inspected build intent",
  );
  return abi;
}

/** Observations from Ghidra, not an echo of the requested profile. */
export function assertPspLoadedImage(image, targetSha256) {
  assert.equal(image.executable_format, "PSP Executable (ELF)");
  assert.equal(image.language_id, "Allegrex:LE:32:default");
  assert.equal(image.compiler_spec_id, "default");
  assert.equal(image.source_files.length, 1);
  assert.equal(image.source_files[0].original_sha256, targetSha256);
  assert.equal(image.source_files[0].modified_sha256, targetSha256);
}

/** Fixed source encodings and independently chosen immediate, not pseudocode. */
export function assertPspProbe(move, bitrev) {
  assert.equal(move.status, "decoded");
  assert.equal(move.length, 4);
  assert.equal(move.bytes, "34120224");
  assert.ok(
    move.operands.some((operand) =>
      operand.components.some(
        (part) =>
          part.kind === "immediate" &&
          part.value !== null &&
          BigInt(part.value) === 0x1234n,
      ),
    ),
  );
  assert.equal(bitrev.status, "decoded");
  assert.equal(bitrev.length, 4);
  assert.match(bitrev.mnemonic, /^bitrev$/iu);
}
