import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const language = (byteOrder) => {
  assert.ok(byteOrder === "little" || byteOrder === "big");
  return `MIPS:${byteOrder === "little" ? "LE" : "BE"}:32:default`;
};
const wordHex = (value, byteOrder) => {
  language(byteOrder);
  const bytes = Buffer.alloc(4);
  if (byteOrder === "little") bytes.writeUInt32LE(value);
  else bytes.writeUInt32BE(value);
  return bytes.toString("hex");
};

const SOFT_FLOAT_SYMBOLS = [
  "rea_mips_soft_pick",
  "rea_mips_soft_wide",
  "rea_mips_soft_mixed",
  "rea_mips_soft_struct",
  "rea_mips_soft_caller",
];

/**
 * Parse only the documented GNU readelf fields needed by our tiny fixtures.
 * `rel` objects carry their own symbol checks in mips-relocatable-checks.mjs.
 */
export function parseMipsReadelf(
  text,
  byteOrder,
  floatAbi = "hard",
  objectType = "exec",
) {
  assert.ok(floatAbi === "hard" || floatAbi === "soft");
  assert.ok(objectType === "exec" || objectType === "rel");
  language(byteOrder);
  const field = (expression, label) => {
    const matches = [...text.matchAll(expression)];
    assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
    return matches[0][1].trim();
  };
  assert.equal(field(/^\s*Class:\s*(.+)$/gmu, "class"), "ELF32");
  assert.equal(
    field(/^\s*Data:.*?,\s*(little|big) endian\s*$/gmu, "byte order"),
    byteOrder,
  );
  assert.match(
    field(/^\s*Type:\s*(.+)$/gmu, "type"),
    objectType === "rel" ? /^REL\b/u : /^EXEC\b/u,
  );
  assert.match(field(/^\s*Machine:\s*(.+)$/gmu, "machine"), /^MIPS\b/u);
  const flags = Number(field(/^\s*Flags:\s*(0x[\da-f]+),.*$/gmu, "flags"));
  assert.equal(flags, 0x70001001, "Fixture ELF flags differ from build intent");
  assert.equal(field(/^ISA:\s*(.+)$/gmu, "ISA"), "MIPS32r2");
  const registerSize = (name) => {
    const bits = Number(
      field(new RegExp(`^${name} size:\\s*(\\d+)\\s*$`, "gmu"), name),
    );
    assert.ok(bits === 0 || bits === 32, `Unexpected ${name} width`);
    return bits === 32 ? 1 : 0;
  };
  const fp = field(/^FP ABI:\s*(.+)$/gmu, "FP ABI");
  const fpAbi = new Map([
    ["Hard float (double precision)", 1],
    ["Hard float (32-bit CPU, Any FPU)", 5],
    ["Soft float", 3],
  ]).get(fp);
  assert.ok(fpAbi !== undefined, `Unrecognized fixture FP ABI: ${fp}`);
  assert.equal(
    fpAbi === 3,
    floatAbi === "soft",
    `Fixture FP ABI ${fp} differs from the ${floatAbi}-float build intent`,
  );
  assert.equal(field(/^ISA Extension:\s*(.+)$/gmu, "ISA extension"), "None");
  assert.equal(field(/^ASEs:\s*\n[ \t]*(.+)$/gmu, "ASEs"), "None");
  const abiFlags = {
    version: Number(
      field(/^MIPS ABI Flags Version:\s*(\d+)\s*$/gmu, "ABI version"),
    ),
    isaLevel: 32,
    isaRevision: 2,
    gprSize: registerSize("GPR"),
    cpr1Size: registerSize("CPR1"),
    cpr2Size: registerSize("CPR2"),
    fpAbi,
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
  const symbols = {};
  for (const name of objectType === "rel"
    ? []
    : [
        "rea_mips_entry",
        "rea_mips_leaf",
        "rea_mips_probe",
        "rea_mips_global",
        "rea_mips_marker",
        ...(floatAbi === "soft" ? SOFT_FLOAT_SYMBOLS : []),
      ]) {
    const value = field(
      new RegExp(
        `^\\s*\\d+:\\s+([\\da-f]+)\\s+\\d+\\s+(?:FUNC|OBJECT)\\s+GLOBAL\\s+\\S+\\s+\\d+\\s+${name}\\s*$`,
        "gmu",
      ),
      `symbol ${name}`,
    );
    symbols[name] = `0x${BigInt(`0x${value}`).toString(16)}`;
  }
  return {
    mips: {
      elfClass: 32,
      byteOrder,
      type: objectType === "rel" ? 1 : 2,
      flags,
      abiFlags,
    },
    symbols,
  };
}

/** Independent reader is a bounded test prerequisite, never an REA provider. */
export async function inspectMipsReadelf(path, byteOrder, floatAbi = "hard") {
  const command = process.env.REA_MIPS_READELF ?? "readelf";
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
    ["-h", "-A", "-s", "-W", path],
    options,
  );
  assert.equal(
    result.stderr.trim(),
    "",
    `readelf diagnostics: ${result.stderr}`,
  );
  return {
    ...parseMipsReadelf(result.stdout, byteOrder, floatAbi),
    command,
    version: version.stdout.split("\n")[0],
    raw: result.stdout,
  };
}

/** Independent GNU readelf interpretation for the recordless legacy fixture. */
export async function inspectLegacyMipsReadelf(path, byteOrder) {
  const command = process.env.REA_MIPS_READELF ?? "readelf";
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
  const header = await execute(command, ["-h", "-W", path], options);
  assert.equal(
    header.stderr.trim(),
    "",
    `readelf diagnostics: ${header.stderr}`,
  );
  const field = (expression, label) => {
    const matches = [...header.stdout.matchAll(expression)];
    assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
    return matches[0][1].trim();
  };
  assert.equal(field(/^\s*Class:\s*(.+)$/gmu, "class"), "ELF32");
  assert.equal(
    field(/^\s*Data:.*?,\s*(little|big) endian\s*$/gmu, "byte order"),
    byteOrder,
  );
  assert.match(field(/^\s*Type:\s*(.+)$/gmu, "type"), /^EXEC\b/u);
  assert.match(field(/^\s*Machine:\s*(.+)$/gmu, "machine"), /^MIPS\b/u);
  const flags = field(/^\s*Flags:\s*(0x[\da-f]+)\b.*$/gmu, "flags");
  assert.equal(
    Number(flags),
    0x50000001,
    "Legacy fixture must carry EF_MIPS_ARCH_32 with an unspecified ABI field",
  );
  const abi = await execute(command, ["-A", path], options);
  assert.equal(abi.stderr.trim(), "", `readelf diagnostics: ${abi.stderr}`);
  // -A also prints unrelated MIPS facts such as the static GOT; only the ABI
  // flags declaration itself must be gone from the recordless fixture.
  assert.doesNotMatch(
    abi.stdout,
    /MIPS ABI Flags Version/u,
    "GNU readelf still observes an ABI flags declaration in the legacy fixture",
  );
  const symbols = await execute(command, ["-s", "-W", path], options);
  assert.equal(
    symbols.stderr.trim(),
    "",
    `readelf diagnostics: ${symbols.stderr}`,
  );
  const parsed = {};
  for (const name of ["rea_mips_entry", "rea_mips_probe"]) {
    const matches = [
      ...symbols.stdout.matchAll(
        new RegExp(
          `^\\s*\\d+:\\s+([\\da-f]+)\\s+\\d+\\s+FUNC\\s+GLOBAL\\s+\\S+\\s+\\d+\\s+${name}\\s*$`,
          "gmu",
        ),
      ),
    ];
    assert.equal(
      matches.length,
      1,
      `Missing or ambiguous readelf symbol ${name}`,
    );
    parsed[name] = `0x${BigInt(`0x${matches[0][1]}`).toString(16)}`;
  }
  return {
    flags: Number(flags),
    limitations: [],
    symbols: parsed,
    command,
    version: version.stdout.split("\n")[0],
    raw: {
      header: header.stdout,
      abi: abi.stdout,
      symbols: symbols.stdout,
    },
  };
}
export function assertMipsLoadedImage(observations, byteOrder, sha256) {
  assert.equal(observations.language_id, language(byteOrder));
  assert.equal(observations.compiler_spec_id, "default");
  assert.ok(
    observations.source_files.some(
      (file) =>
        file.original_sha256 === sha256 && file.modified_sha256 === sha256,
    ),
    "Ghidra loaded source identity changed",
  );
}

/** Verify the exact constant/conditional destination in mips-probe.S. */
export function assertMipsProbe(move, branch, byteOrder, address) {
  const start = BigInt(address);
  for (const [instruction, offset, word] of [
    [move, 0n, 0x24821234],
    [branch, 4n, 0x10800003],
  ]) {
    assert.equal(instruction.status, "decoded");
    assert.equal(BigInt(instruction.address), start + offset);
    assert.equal(instruction.architecture, language(byteOrder));
    assert.equal(instruction.length, 4);
    assert.equal(instruction.bytes, wordHex(word, byteOrder));
  }
  assert.match(move.mnemonic, /^ADDIU$/iu);
  assert.ok(
    move.operands.some(
      (operand) =>
        operand.index === 2 &&
        operand.components.some(
          (part) =>
            part.kind === "immediate" &&
            part.value !== null &&
            BigInt(part.value) === 0x1234n,
        ),
    ),
    "ADDIU immediate was not recovered",
  );
  assert.match(branch.mnemonic, /^BEQZ?$/iu);
  assert.equal(branch.flow.kind, "jump");
  assert.equal(branch.flow.conditional, true);
  assert.equal(branch.flow.computed, false);
  assert.deepEqual(
    branch.flow.direct_destinations.map((value) => BigInt(value)),
    [start + 20n],
  );
}

/** Four bytes must encode the known source-owned global in the declared order. */
export function assertMipsGlobal(bytes, byteOrder) {
  assert.equal(bytes, wordHex(7, byteOrder));
}

/**
 * Soft-float o32 places float/double values exactly where a same-size integer
 * goes: Ghidra joins register pairs most-significant word first. The struct
 * return keeps its hidden $a0 pointer and its float in $a1.
 */
export function assertMipsSoftFloatStorage(boundaries, byteOrder) {
  language(byteOrder);
  const pair = (low, high) =>
    byteOrder === "little" ? `${high}:4,${low}:4` : `${low}:4,${high}:4`;
  const expected = {
    rea_mips_soft_pick: {
      return: ["float", "v0:4"],
      parameters: [
        ["a", "float", "a0:4"],
        ["b", "float", "a1:4"],
        ["sel", "int", "a2:4"],
      ],
    },
    rea_mips_soft_wide: {
      return: ["double", pair("v0", "v1")],
      parameters: [
        ["a", "double", pair("a0", "a1")],
        ["sel", "int", "a2:4"],
      ],
    },
    rea_mips_soft_mixed: {
      return: ["double", pair("v0", "v1")],
      parameters: [
        ["i", "int", "a0:4"],
        ["d", "double", pair("a2", "a3")],
        ["f", "float", "Stack[0x10]:4"],
        ["e", "double", "Stack[0x18]:8"],
      ],
    },
    rea_mips_soft_struct: {
      return: ["rea_mips_soft_pair *", "v0:4"],
      parameters: [
        ["__return_storage_ptr__", "rea_mips_soft_pair *", "a0:4 (auto)"],
        ["scale", "float", "a1:4"],
        ["sel", "int", "a2:4"],
      ],
    },
  };
  assert.deepEqual(
    Object.keys(boundaries).sort(),
    Object.keys(expected).sort(),
  );
  for (const [name, want] of Object.entries(expected)) {
    const boundary = boundaries[name];
    assert.deepEqual(
      [boundary.return_type.data_type, boundary.return_type.storage],
      want.return,
      `${name} return storage`,
    );
    assert.deepEqual(
      [...boundary.parameters]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((item) => [item.name, item.data_type, item.storage]),
      want.parameters,
      `${name} parameter storage`,
    );
  }
}
