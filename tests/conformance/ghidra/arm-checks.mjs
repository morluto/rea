import assert from "node:assert/strict";

/** Parse only the documented GNU readelf fields needed by the armhf fixture. */
export function parseArmReadelf(text) {
  const field = (expression, label) => {
    const matches = [...text.matchAll(expression)];
    assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
    return matches[0][1].trim();
  };
  assert.equal(field(/^\s*Class:\s*(.+)$/gmu, "class"), "ELF32");
  assert.equal(
    field(/^\s*Data:.*?,\s*(little|big) endian\s*$/gmu, "byte order"),
    "little",
  );
  assert.match(field(/^\s*Type:\s*(.+)$/gmu, "type"), /^EXEC\b/u);
  assert.match(field(/^\s*Machine:\s*(.+)$/gmu, "machine"), /^ARM\b/u);
  const flags = field(/^\s*Flags:\s*(0x[\da-f]+),.*$/gmu, "flags");
  assert.equal(
    Number(flags) & 0xff000000,
    0x05000000,
    "Fixture EABI version differs from build intent",
  );
  assert.equal(
    Number(flags) & 0x400,
    0x400,
    "Fixture float convention differs from hard-float build intent",
  );
  const symbols = {};
  for (const name of [
    "rea_arm_entry",
    "rea_arm_leaf",
    "rea_arm_probe_arm",
    "rea_arm_probe_thumb",
    "rea_arm_global",
    "rea_arm_marker",
  ]) {
    const value = field(
      new RegExp(
        `^\\s*\\d+:\\s+([\\da-f]+)\\s+\\d+\\s+(?:FUNC|OBJECT)\\s+GLOBAL\\s+\\S+\\s+\\d+\\s+${name}\\s*$`,
        "gmu",
      ),
      `symbol ${name}`,
    );
    // Thumb function symbols carry the low state bit; Ghidra's loader masks it.
    const masked =
      name === "rea_arm_probe_thumb"
        ? (BigInt(`0x${value}`) & ~1n).toString(16)
        : value;
    symbols[name] = `0x${BigInt(`0x${masked}`).toString(16)}`;
  }
  return { flags: Number(flags), symbols };
}

/** Independent reader is a bounded test prerequisite, never an REA provider. */
export async function inspectArmReadelf(commands, path) {
  const command = process.env.REA_ARM_READELF ?? "readelf";
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
    ...parseArmReadelf(result.stdout),
    command,
    version: version.stdout.split("\n")[0],
    raw: result.stdout,
  };
}

/** Check effective Ghidra observations, not the requested analysis profile. */
export function assertArmLoadedImage(observations, sha256) {
  assert.equal(observations.language_id, "ARM:LE:32:v7");
  assert.equal(observations.compiler_spec_id, "default");
  assert.ok(
    observations.source_files.some(
      (file) =>
        file.original_sha256 === sha256 && file.modified_sha256 === sha256,
    ),
    "Ghidra loaded source identity changed",
  );
}

/**
 * Verify the fixed probe encodings (raw LE bytes): the ARM probe's immediate
 * move, and the Thumb probe's two genuine 32-bit Thumb-2 encodings. The ARM
 * probe also branches into the Thumb probe (see arm-probe.S), so decoding both
 * states here proves the interworked image is analyzed per instruction state.
 */
export function assertArmProbe(armProbe, thumbMovw, thumbMovt) {
  assert.equal(armProbe.status, "decoded");
  assert.equal(armProbe.length, 4);
  assert.equal(armProbe.bytes, "2a00a0e3");
  assert.match(armProbe.mnemonic, /^MOV$/iu);
  assert.equal(thumbMovw.status, "decoded");
  assert.equal(thumbMovw.length, 4);
  assert.equal(thumbMovw.bytes, "41f23420");
  assert.match(thumbMovw.mnemonic, /^MOVW$/iu);
  assert.equal(thumbMovt.status, "decoded");
  assert.equal(thumbMovt.length, 4);
  assert.equal(thumbMovt.bytes, "c5f27860");
  assert.match(thumbMovt.mnemonic, /^MOVT$/iu);
}
