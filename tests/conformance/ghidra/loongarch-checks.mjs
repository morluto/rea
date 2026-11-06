import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** The lane binds this language; Ghidra's opinion also maps soft float to it. */
const LANGUAGE = "Loongarch:LE:64:lp64d";

/** Little-endian bytes of the three source-owned probe instructions. */
const PROBE_HEX = "0414c002840cc0022000004c";
/** `int rea_loongarch_global = 42` in little-endian memory order. */
const GLOBAL_HEX = "2a000000";

const FLOAT_ABI = {
  0: "unspecified",
  1: "soft",
  2: "single",
  3: "double",
};

/** Parse only the documented GNU readelf fields needed by this small fixture. */
export function parseLoongArchReadelf(text, expected = {}) {
  const field = (expression, label) => {
    const matches = [...text.matchAll(expression)];
    assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
    return matches[0][1].trim();
  };
  assert.equal(field(/^\s*Class:\s*(.+)$/gmu, "class"), "ELF64");
  assert.equal(
    field(/^\s*Data:.*?,\s*(little|big) endian\s*$/gmu, "byte order"),
    "little",
  );
  const typeText = field(/^\s*Type:\s*(.+)$/gmu, "type");
  const type = /^DYN\b/u.test(typeText)
    ? 3
    : /^EXEC\b/u.test(typeText)
      ? 2
      : null;
  assert.notEqual(type, null, `Unexpected readelf e_type ${typeText}`);
  assert.equal(field(/^\s*Machine:\s*(.+)$/gmu, "machine"), "LoongArch");
  const flags = Number(
    field(/^\s*Flags:\s*(0x[\da-f]+)\s*(?:,.*)?$/gmu, "flags"),
  );
  if (expected.type !== undefined)
    assert.equal(
      type,
      expected.type,
      "Fixture e_type differs from build intent",
    );
  if (expected.flags !== undefined)
    assert.equal(
      flags,
      expected.flags,
      "Fixture e_flags differ from build intent",
    );

  const symbols = {};
  for (const name of [
    "rea_loongarch_add",
    "rea_loongarch_entry",
    "rea_loongarch_probe",
    "rea_loongarch_global",
  ]) {
    // The read-only fixture keeps both .dynsym and .symtab; every occurrence
    // must agree, and the first one is the observation this lane uses.
    const values = [
      ...text.matchAll(
        new RegExp(
          `^\\s*\\d+:\\s+([\\da-f]+)\\s+\\d+\\s+(?:FUNC|OBJECT)\\s+GLOBAL\\s+\\S+\\s+\\d+\\s+${name}\\s*$`,
          "gmu",
        ),
      ),
    ].map((match) => `0x${BigInt(`0x${match[1]}`).toString(16)}`);
    assert.ok(values.length > 0, `Missing readelf symbol ${name}`);
    assert.equal(
      new Set(values).size,
      1,
      `readelf symbol ${name} has conflicting addresses`,
    );
    symbols[name] = values[0];
  }

  const relocations = {};
  for (const match of text.matchAll(
    /^\s*[\da-f]+\s+[\da-f]+\s+(R_LARCH_\w+)\s+/gmu,
  )) {
    relocations[match[1]] = (relocations[match[1]] ?? 0) + 1;
  }
  return {
    loongarch: {
      elfClass: 64,
      byteOrder: "little",
      type,
      flags,
      floatAbi: FLOAT_ABI[flags & 0x7] ?? "reserved",
      objectAbiVersion: (flags & 0x40) === 0 ? 0 : 1,
      undeclaredFlags: (flags & ~0x47) >>> 0,
    },
    symbols,
    relocations,
  };
}

/** Independent reader is a bounded test prerequisite, never an REA provider. */
export async function inspectLoongArchReadelf(path, expected = {}) {
  const command = process.env.REA_LOONGARCH_READELF ?? "readelf";
  const options = {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  };
  const version = await execute(command, ["--version"], options);
  assert.match(
    version.stdout,
    /^GNU readelf\b/u,
    "This lane requires GNU readelf",
  );
  const result = await execute(
    command,
    ["-h", "-s", "-W", "-r", path],
    options,
  );
  assert.equal(
    result.stderr.trim(),
    "",
    `readelf diagnostics: ${result.stderr}`,
  );
  return {
    ...parseLoongArchReadelf(result.stdout, expected),
    command,
    version: version.stdout.split("\n")[0],
    raw: result.stdout,
  };
}

/** Numeric offset of a provider coordinate, ignoring an address-space prefix. */
export function analysisAddressOffset(address) {
  const text = String(address);
  return BigInt(text.slice(text.lastIndexOf(":") + 1));
}

/**
 * Check effective Ghidra observations, not the requested analysis profile.
 * A shared image's loaded memory differs from its source bytes after dynamic
 * relocations, so only the original identity must match the fixture.
 */
export function assertLoongArchLoadedImage(observations, sha256) {
  assert.equal(observations.language_id, LANGUAGE);
  assert.equal(observations.compiler_spec_id, "default");
  assert.ok(
    observations.source_files.some((file) => file.original_sha256 === sha256),
    "Ghidra loaded source identity changed",
  );
}

/** The source-owned global must survive the R_LARCH_64 relocation fixup. */
export function assertLoongArchGlobalBytes(bytes) {
  assert.equal(bytes, GLOBAL_HEX);
}

/** Exact probe instruction bytes at the independently reported symbol. */
export function assertLoongArchProbeBytes(bytes) {
  assert.equal(bytes, PROBE_HEX);
}

/** Ghidra prints `addi.d` for both encodings and `ret` for `jr $ra`. */
export function assertLoongArchProbeInstructions(instructions, address) {
  const start = BigInt(address);
  assert.deepEqual(
    instructions.map((line) => line.replace(/^\S+\s+/u, "")),
    ["addi.d a0, zero, 0x5", "addi.d a0, a0, 0x3", "ret"],
  );
  for (const [index, line] of instructions.entries())
    assert.match(
      line,
      new RegExp(`^0x${(start + BigInt(index) * 4n).toString(16)}:\\s`, "u"),
      "Listing line is not at its expected address",
    );
}

/** The probe folds to 5 + 3; pseudocode presence alone is not semantics. */
export function assertLoongArchProbePseudocode(pseudocode) {
  assert.equal(typeof pseudocode, "string");
  assert.match(pseudocode, /\breturn\b/u);
  assert.match(pseudocode, /\b8\b/u);
}
