#!/usr/bin/env node
// Source-only checks for caller-selected, read-only PSP symbol comparison.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  correlatePspSymbols,
  parsePspSymbols,
} from "./psp-symbol-correlation.mjs";

const targetSha256 = "a".repeat(64);
const inventory = [
  { address: "0x08805000", value: "hunter_init" },
  { address: "0x08805020", value: "other_name" },
];
const settings = {
  format: "sym",
  sourceBase: "0x08000000",
  analysisBase: "0x08800000",
  targetSha256,
};
const legacy = [
  "08005000 hunter_init,0020",
  "08005020 hunter_step,0010",
  "08007000 missing_symbol,0008",
  "",
].join("\n");
const report = correlatePspSymbols(legacy, inventory, settings);
assert.deepEqual(
  report.records.map((row) => row.outcome),
  ["address_and_label_agree", "address_only", "not_observed"],
);
assert.equal(report.records[0].source_address, "0x8005000");
assert.equal(report.records[0].analysis_address, "0x8805000");
assert.equal(report.selected_bases.source, "0x8000000");
assert.equal(report.selected_bases.analysis, "0x8800000");
assert.match(report.source_sha256, /^[a-f0-9]{64}$/u);
assert.equal(report.target_sha256, targetSha256);
assert.equal(report.crc_checked, false);
assert.deepEqual(report.observed_labels_by_address["0x8805000"], ["hunter_init"]);
assert.equal(report.records[0].observed_labels, undefined);
assert.equal(report.ignored_unselected_space_rows, 0);

const withOtherSpaces = correlatePspSymbols(
  legacy,
  [
    ...inventory,
    { address: "EXTERNAL:0x1", value: "sceKernelLibcTime" },
    { address: "ram:0x08805000", value: "different_space" },
  ],
  settings,
);
assert.deepEqual(
  withOtherSpaces.records.map(({ outcome }) => outcome),
  report.records.map(({ outcome }) => outcome),
);
assert.equal(withOtherSpaces.ignored_unselected_space_rows, 2);
assert.deepEqual(withOtherSpaces.observed_labels_by_address, report.observed_labels_by_address);

const duplicateHeavy = correlatePspSymbols(
  "08005000 hunter_init,0020\n".repeat(8192),
  Array.from({ length: 50000 }, () => inventory[0]),
  settings,
);
assert.equal(duplicateHeavy.records.length, 8192);
assert.equal(duplicateHeavy.records[0].outcome, "ambiguous");
assert.equal(duplicateHeavy.observed_labels_by_address["0x8805000"].length, 50000);
assert.ok(JSON.stringify(duplicateHeavy).length < 4 * 1024 * 1024);

const wrongBase = correlatePspSymbols(legacy, inventory, {
  ...settings,
  analysisBase: "0x08810000",
});
assert.ok(
  wrongBase.records.every((row) => row.outcome !== "address_and_label_agree"),
);
const repeated = correlatePspSymbols(
  "08005000 hunter_init,0020\n08005000 alias,0020\n",
  inventory,
  settings,
);
assert.deepEqual(
  repeated.records.map((row) => row.outcome),
  ["ambiguous", "ambiguous"],
);
const placeholder = correlatePspSymbols(
  "08005000 z_un_08005000,0010\n",
  inventory,
  settings,
);
assert.equal(placeholder.records[0].outcome, "generated_placeholder");
assert.equal(
  correlatePspSymbols("07ffffff out_of_range,0004\n", inventory, settings)
    .records[0].outcome,
  "outside_selected_mapping",
);
assert.equal(
  correlatePspSymbols(legacy, [inventory[0], inventory[0]], settings).records[0]
    .outcome,
  "ambiguous",
);

const modern = [
  ".ppsym 1",
  "crc 12345678",
  "# game TEST-0000 A source-owned example",
  "F 00001000 00000020 hunter_init",
  "D 00001080 00000004 word counter",
  "L 00001090 spare_label",
  "",
].join("\n");
const module = correlatePspSymbols(modern, inventory, {
  format: "ppsym",
  analysisBase: "0x08804000",
  expectedCrc: "0x12345678",
  targetSha256,
});
assert.equal(module.records.length, 1);
assert.equal(module.records[0].outcome, "address_and_label_agree");
assert.equal(module.records[0].analysis_address, "0x8805000");
assert.equal(module.module_crc, "0x12345678");
assert.equal(module.crc_checked, true);
assert.equal(module.ignored_nonfunction_records, 2);
assert.throws(
  () =>
    correlatePspSymbols(modern, inventory, {
      format: "ppsym",
      analysisBase: "0x08804000",
      expectedCrc: "0x87654321",
      targetSha256,
    }),
  /CRC does not match/u,
);
assert.throws(
  () => parsePspSymbols(".ppsym 2\ncrc 12345678\n", "ppsym"),
  /Unsupported/u,
);
assert.throws(
  () => parsePspSymbols("08005000 unbounded,nothex\n", "sym"),
  /Invalid/u,
);
assert.throws(
  () =>
    correlatePspSymbols(legacy, inventory, {
      ...settings,
      targetSha256: "invalid",
    }),
  /SHA-256/u,
);
assert.throws(
  () =>
    correlatePspSymbols(
      legacy,
      [{ address: "not-an-address", value: "name" }],
      settings,
    ),
  /hex address/u,
);
// Exercise the documented command boundary, not just exported functions.
const scratch = await mkdtemp(join(tmpdir(), "rea-psp-symbol-check-"));
try {
  const symbolsPath = join(scratch, "source.sym");
  const rawInventoryPath = join(scratch, "functions.json");
  const evidencePath = join(scratch, "evidence.json");
  const invalidSymbolsPath = join(scratch, "invalid-utf8.sym");
  await writeFile(symbolsPath, legacy);
  await writeFile(rawInventoryPath, JSON.stringify(inventory));
  await writeFile(evidencePath, JSON.stringify({
    normalized_result: inventory,
    subject: { digest: { sha256: targetSha256 } },
  }));
  await writeFile(invalidSymbolsPath, Buffer.concat([
    Buffer.from("08005000 "),
    Buffer.from([0xff]),
    Buffer.from(",0020\n"),
  ]));
  const command = fileURLToPath(new URL("./psp-symbol-correlation.mjs", import.meta.url));
  const run = (inventoryPath, additions = []) =>
    spawnSync(process.execPath, [
      command,
      "--symbols", symbolsPath,
      "--inventory", inventoryPath,
      "--format", "sym",
      "--source-base", settings.sourceBase,
      "--analysis-base", settings.analysisBase,
      "--target-sha256", targetSha256,
      ...additions,
    ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const raw = run(rawInventoryPath);
  assert.equal(raw.status, 0, raw.stderr);
  const rawReport = JSON.parse(raw.stdout);
  assert.deepEqual(rawReport.records, report.records);
  assert.deepEqual(rawReport.observed_labels_by_address, report.observed_labels_by_address);
  assert.deepEqual(rawReport.input_paths, { symbols: symbolsPath, inventory: rawInventoryPath });
  assert.equal(rawReport.inventory_target_claim, null);

  const fromEvidence = run(evidencePath);
  assert.equal(fromEvidence.status, 0, fromEvidence.stderr);
  const evidenceReport = JSON.parse(fromEvidence.stdout);
  assert.deepEqual(evidenceReport.input_paths, { symbols: symbolsPath, inventory: evidencePath });
  assert.equal(evidenceReport.inventory_target_claim, targetSha256);
  assert.deepEqual(evidenceReport.records, rawReport.records);

  const rejectedDigest = run(evidencePath, ["--target-sha256", "b".repeat(64)]);
  assert.notEqual(rejectedDigest.status, 0);
  assert.match(rejectedDigest.stderr, /Unknown or repeated flag/u);
  const wrongTarget = spawnSync(process.execPath, [
    command,
    "--symbols", symbolsPath,
    "--inventory", evidencePath,
    "--format", "sym",
    "--source-base", settings.sourceBase,
    "--analysis-base", settings.analysisBase,
    "--target-sha256", "b".repeat(64),
  ], { encoding: "utf8" });
  assert.notEqual(wrongTarget.status, 0);
  assert.equal(wrongTarget.stdout, "");
  assert.match(wrongTarget.stderr, /Inventory target identity disagrees/u);

  const invalid = spawnSync(process.execPath, [
    command,
    "--symbols", invalidSymbolsPath,
    "--inventory", rawInventoryPath,
    "--format", "sym",
    "--source-base", settings.sourceBase,
    "--analysis-base", settings.analysisBase,
    "--target-sha256", targetSha256,
  ], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /encoded data|utf-8/iu);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  "PSP_SYMBOL_CORRELATION_SOURCE_PASS: formats, address spaces, bounded output, UTF-8, CLI and identity refusals",
);
