#!/usr/bin/env node
// Source-only checks for caller-selected, read-only PSP symbol comparison.
import assert from "node:assert/strict";
import { correlatePspSymbols, parsePspSymbols } from "./psp-symbol-correlation.mjs";

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
assert.deepEqual(report.records.map((row) => row.outcome), [
  "address_and_label_agree",
  "address_only",
  "not_observed",
]);
assert.equal(report.records[0].source_address, "0x8005000");
assert.equal(report.records[0].analysis_address, "0x8805000");
assert.equal(report.selected_bases.source, "0x8000000");
assert.equal(report.selected_bases.analysis, "0x8800000");
assert.match(report.source_sha256, /^[a-f0-9]{64}$/u);
assert.equal(report.target_sha256, targetSha256);
assert.equal(report.crc_checked, false);

const wrongBase = correlatePspSymbols(legacy, inventory, {
  ...settings,
  analysisBase: "0x08810000",
});
assert.ok(wrongBase.records.every((row) => row.outcome !== "address_and_label_agree"));
const repeated = correlatePspSymbols(
  "08005000 hunter_init,0020\n08005000 alias,0020\n",
  inventory,
  settings,
);
assert.deepEqual(repeated.records.map((row) => row.outcome), ["ambiguous", "ambiguous"]);
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
  correlatePspSymbols(legacy, [inventory[0], inventory[0]], settings)
    .records[0].outcome,
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
assert.throws(() => correlatePspSymbols(modern, inventory, {
  format: "ppsym",
  analysisBase: "0x08804000",
  expectedCrc: "0x87654321",
  targetSha256,
}), /CRC does not match/u);
assert.throws(() => parsePspSymbols(".ppsym 2\ncrc 12345678\n", "ppsym"), /Unsupported/u);
assert.throws(() => parsePspSymbols("08005000 unbounded,nothex\n", "sym"), /Invalid/u);
assert.throws(() => correlatePspSymbols(legacy, inventory, {
  ...settings, targetSha256: "invalid",
}), /SHA-256/u);
assert.throws(() => correlatePspSymbols(legacy, [
  { address: "not-an-address", value: "name" },
], settings), /hex address/u);
console.log("PSP_SYMBOL_CORRELATION_SOURCE_PASS: legacy and module-relative maps, identity, ambiguity and refusals");
