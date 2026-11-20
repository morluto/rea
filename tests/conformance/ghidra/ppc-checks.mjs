import assert from "node:assert/strict";
import { FIXTURE_TOOLS, fixtureCommand } from "./fixture-toolchain.mjs";

// The lane binds this language; Ghidra's ELF loader alone selects e500.
const LANGUAGE = "PowerPC:BE:32:default";
// The 64-bit lane binds Ghidra's Power ISA 3.0 languages; its G2-era 64-bit
// `default` languages stop at the probe's VSX instruction.
const LANGUAGE64 = Object.freeze({
  little: "PowerPC:LE:64:A2ALT",
  big: "PowerPC:BE:64:A2ALT",
});
const wordHex = (value, byteOrder = "big") => {
  const bytes = Buffer.alloc(4);
  if (byteOrder === "little") bytes.writeUInt32LE(value);
  else bytes.writeUInt32BE(value);
  return bytes.toString("hex");
};
const hex = (value) => `0x${BigInt(value).toString(16)}`;

/** One field the fixture's GNU readelf output must state exactly once. */
const readelfMatch = (text, expression, label) => {
  const matches = [...text.matchAll(expression)];
  assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
  return matches[0];
};
const readelfField = (text, expression, label) =>
  readelfMatch(text, expression, label)[1].trim();

/** Header fields shared by both classes, checked against the build intent. */
const readelfHeader = (text, { elfClass, byteOrder, machine }) => {
  assert.equal(
    readelfField(text, /^\s*Class:\s*(.+)$/gmu, "class"),
    `ELF${elfClass}`,
  );
  assert.equal(
    readelfField(
      text,
      /^\s*Data:.*?,\s*(little|big) endian\s*$/gmu,
      "byte order",
    ),
    byteOrder,
  );
  assert.match(readelfField(text, /^\s*Type:\s*(.+)$/gmu, "type"), /^EXEC\b/u);
  assert.equal(
    readelfField(text, /^\s*Machine:\s*(.+)$/gmu, "machine"),
    machine,
  );
  // GNU readelf appends the decoded PPC64 ABI, for example "0x2, abiv2".
  return Number(
    readelfField(text, /^\s*Flags:\s*(0x[\da-f]+)(?:,.*)?\s*$/gmu, "flags"),
  );
};

/** A defined global symbol and, for ELFv2 functions, its local entry offset. */
const readelfSymbol = (text, name) => {
  const match = readelfMatch(
    text,
    new RegExp(
      `^\\s*\\d+:\\s+([\\da-f]+)\\s+\\d+\\s+(?:FUNC|OBJECT)\\s+GLOBAL\\s+\\S+(?:\\s+\\[<localentry>: (\\d+)\\])?\\s+\\d+\\s+${name}\\s*$`,
      "gmu",
    ),
    `symbol ${name}`,
  );
  return {
    value: hex(`0x${match[1]}`),
    localEntry: match[2] === undefined ? 0 : Number(match[2]),
  };
};

/** Parse only the documented GNU readelf fields needed by our tiny fixture. */
export function parsePowerPcReadelf(text) {
  const flags = readelfHeader(text, {
    elfClass: 32,
    byteOrder: "big",
    machine: "PowerPC",
  });
  assert.equal(flags, 0, "Fixture ELF flags differ from build intent");
  const symbols = {};
  for (const name of [
    "rea_ppc_entry",
    "rea_ppc_leaf",
    "rea_ppc_probe",
    "rea_ppc_global",
    "rea_ppc_marker",
  ]) {
    const symbol = readelfSymbol(text, name);
    assert.equal(symbol.localEntry, 0, `${name} declares a local entry`);
    symbols[name] = symbol.value;
  }
  return {
    powerpc: { elfClass: 32, byteOrder: "big", type: 2, flags },
    symbols,
  };
}

/**
 * Parse the ELFv2 PPC64 fixture. Each C function reads a global through the
 * TOC, so its global entry sets up r2 and its local entry starts 8 bytes in;
 * the assembly probe has a single entry.
 */
export function parsePowerPc64Readelf(text, byteOrder) {
  const flags = readelfHeader(text, {
    elfClass: 64,
    byteOrder,
    machine: "PowerPC64",
  });
  assert.equal(flags, 2, "Fixture ELF flags are not the ELFv2 ABI");
  const symbols = {};
  const localEntries = {};
  for (const [name, localEntry] of [
    ["rea_ppc64_entry", 8],
    ["rea_ppc64_leaf", 8],
    ["rea_ppc64_probe", 0],
    ["rea_ppc64_global", 0],
    ["rea_ppc64_marker", 0],
  ]) {
    const symbol = readelfSymbol(text, name);
    assert.equal(
      symbol.localEntry,
      localEntry,
      `${name} local entry offset differs from the fixture's TOC use`,
    );
    symbols[name] = symbol.value;
    if (localEntry !== 0)
      localEntries[name] = hex(BigInt(symbol.value) + BigInt(localEntry));
  }
  return {
    powerpc: { elfClass: 64, byteOrder, type: 2, flags },
    symbols,
    localEntries,
  };
}

const readelfReport = async (commands, path) => {
  const command = fixtureCommand(FIXTURE_TOOLS.ppcReadelf);
  const options = {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  };
  const version = await commands.exec(command, ["--version"], options);
  assert.match(
    version.stdout,
    /^GNU readelf\b/u,
    "This lane requires GNU readelf",
  );
  const result = await commands.exec(
    command,
    ["-h", "-s", "-W", path],
    options,
  );
  assert.equal(
    result.stderr.trim(),
    "",
    `readelf diagnostics: ${result.stderr}`,
  );
  return {
    command,
    version: version.stdout.split("\n")[0],
    raw: result.stdout,
  };
};

/** Independent reader is a bounded test prerequisite, never an REA provider. */
export async function inspectPowerPcReadelf(commands, path) {
  const report = await readelfReport(commands, path);
  return { ...parsePowerPcReadelf(report.raw), ...report };
}

/** The same independent reader for one 64-bit fixture. */
export async function inspectPowerPc64Readelf(commands, path, byteOrder) {
  const report = await readelfReport(commands, path);
  return { ...parsePowerPc64Readelf(report.raw, byteOrder), ...report };
}

/** Check effective Ghidra observations, not the requested analysis profile. */
export function assertPowerPcLoadedImage(observations, sha256) {
  assertLoadedImage(observations, sha256, LANGUAGE);
}

/** The 64-bit lane's effective language follows the fixture's byte order. */
export function assertPowerPc64LoadedImage(observations, sha256, byteOrder) {
  assertLoadedImage(observations, sha256, LANGUAGE64[byteOrder]);
}

function assertLoadedImage(observations, sha256, language) {
  assert.equal(observations.language_id, language);
  assert.equal(observations.compiler_spec_id, "default");
  assert.ok(
    observations.source_files.some(
      (file) =>
        file.original_sha256 === sha256 && file.modified_sha256 === sha256,
    ),
    "Ghidra loaded source identity changed",
  );
}

/** One decoded probe word at its fixed offset, in the file's byte order. */
function assertProbeWord(instruction, start, [offset, word], decoding) {
  assert.equal(instruction.status, "decoded");
  assert.equal(BigInt(instruction.address), start + offset);
  assert.equal(instruction.architecture, decoding.language);
  assert.equal(instruction.length, 4);
  assert.equal(instruction.bytes, wordHex(word, decoding.order));
}

/** The probe's ADDI immediate and conditional branch, shared by both lanes. */
function assertProbeFlow(move, branch, start, destination) {
  assert.match(move.mnemonic, /^ADDI$/iu);
  assert.ok(
    move.operands.some((operand) =>
      operand.components.some(
        (part) =>
          part.kind === "immediate" &&
          part.value !== null &&
          BigInt(part.value) === 0x1234n,
      ),
    ),
    "ADDI immediate was not recovered",
  );
  assert.match(branch.mnemonic, /^BEQ$/iu);
  assert.equal(branch.flow.kind, "jump");
  assert.equal(branch.flow.conditional, true);
  assert.equal(branch.flow.computed, false);
  assert.deepEqual(
    branch.flow.direct_destinations.map((value) => BigInt(value)),
    [start + destination],
  );
}

const BIG32 = Object.freeze({ language: LANGUAGE, order: "big" });

/** Verify the exact constant/conditional destination in ppc-probe.S. */
export function assertPowerPcProbe(move, branch, address) {
  const start = BigInt(address);
  assertProbeWord(move, start, [0n, 0x38641234], BIG32);
  assertProbeWord(branch, start, [8n, 0x41820008], BIG32);
  assertProbeFlow(move, branch, start, 16n);
}

/**
 * Verify ppc64-probe.S: the same ADDI and BEQ checks, and the VSX XXLOR that
 * only a Power ISA language decodes.
 */
export function assertPowerPc64Probe({ move, branch, vector }, address, order) {
  const start = BigInt(address);
  const decoding = { language: LANGUAGE64[order], order };
  assertProbeWord(move, start, [0n, 0x38641234], decoding);
  assertProbeWord(branch, start, [8n, 0x4182000c], decoding);
  assertProbeWord(vector, start, [12n, 0xf0011490], decoding);
  assertProbeFlow(move, branch, start, 20n);
  assert.match(vector.mnemonic, /^XXLOR$/iu);
}

/** Four bytes must encode the known source-owned global in big-endian order. */
export function assertPowerPcGlobal(bytes) {
  assert.equal(bytes, wordHex(7));
}

/** The 64-bit global's eight bytes in the fixture's byte order. */
export function assertPowerPc64Global(bytes, byteOrder) {
  const expected = Buffer.from("0102030405060708", "hex");
  if (byteOrder === "little") expected.reverse();
  assert.equal(bytes, expected.toString("hex"));
}

/**
 * An ELFv2 function with a TOC prologue keeps its symbol on the global entry,
 * which Ghidra models as a thunk to the body at the local entry. Callers that
 * share the TOC branch to the local entry, so call recovery names the body.
 */
export function assertPowerPc64EntryPair(globalDossier, localDossier, pair) {
  assert.equal(BigInt(globalDossier.procedure.address), BigInt(pair.global));
  assert.equal(globalDossier.procedure.classification.thunk, true);
  assert.equal(
    BigInt(globalDossier.procedure.classification.thunk_target),
    BigInt(pair.local),
  );
  assert.equal(BigInt(localDossier.procedure.address), BigInt(pair.local));
  assert.equal(localDossier.procedure.classification.thunk, false);
  assert.ok(localDossier.pseudocode.trim().length > 0);
}
