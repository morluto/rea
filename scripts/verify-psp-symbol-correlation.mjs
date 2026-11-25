#!/usr/bin/env node
// Local checks for caller-selected, read-only PSP symbol comparison.
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidence } from "#dist/domain/evidence.js";
import { unknownTarget } from "#dist/domain/targetIdentity.js";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
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
assert.deepEqual(report.observed_labels_by_address["0x8805000"], [
  "hunter_init",
]);
assert.equal(report.records[0].observed_labels, undefined);
assert.equal(report.ignored_unselected_space_rows, 0);

const withOtherSpaces = correlatePspSymbols(
  legacy,
  [
    ...inventory,
    { address: "EXTERNAL:0x1", value: "sceKernelLibcTime" },
    { address: "ram:0x08805000", value: "different_space_at_same_offset" },
    { address: "overlay%3a1:0x0880500A", value: "different_space" },
  ],
  settings,
);
assert.deepEqual(
  withOtherSpaces.records.map(({ outcome }) => outcome),
  report.records.map(({ outcome }) => outcome),
);
assert.equal(withOtherSpaces.ignored_unselected_space_rows, 3);
assert.deepEqual(
  withOtherSpaces.observed_labels_by_address,
  report.observed_labels_by_address,
);

const duplicateHeavy = correlatePspSymbols(
  "08005000 hunter_init,0020\n".repeat(8192),
  Array.from({ length: 50000 }, () => inventory[0]),
  settings,
);
assert.equal(duplicateHeavy.records.length, 8192);
assert.equal(duplicateHeavy.records[0].outcome, "ambiguous");
assert.equal(
  duplicateHeavy.observed_labels_by_address["0x8805000"].length,
  50000,
);
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
  "08005000 z_un_08005000,0010\n08005020 z_un_custom,0010\n",
  [inventory[0], { address: "0x08805020", value: "z_un_custom" }],
  settings,
);
assert.deepEqual(
  placeholder.records.map(({ outcome }) => outcome),
  ["generated_placeholder", "address_and_label_agree"],
);
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
const commaLabel = parsePspSymbols("08005000 pair<int,int>,0020\n", "sym");
assert.equal(commaLabel.entries[0].name, "pair<int,int>");
assert.equal(commaLabel.entries[0].size, 0x20n);

// Validate skipped records against PPSSPP's written .ppsym layouts.
// Data records may have an empty name; bare labels must be named.
assert.equal(
  parsePspSymbols(".ppsym 1\ncrc 0\nD 00001080 00000004 word\n", "ppsym")
    .omittedNonfunctions,
  1,
);
for (const invalid of [
  "D definitely-not-a-valid-data-record",
  "L definitely-not-a-valid-label-record",
  "D 00001080 wrong-size word counter",
  "D 00001080 00000004 bogus counter",
  "L 00001090",
]) {
  assert.throws(
    () => parsePspSymbols(`.ppsym 1\ncrc 12345678\n${invalid}\n`, "ppsym"),
    /Invalid \.ppsym nonfunction/u,
    invalid,
  );
}
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
const verification = createVerifierRun();
const fixture = await VerifierFixture.open({
  prefix: "rea-psp-symbol-check-",
  private: false,
});
const scratch = fixture.path;
try {
  const commands = await createVerifierCommands();
  fixture.releaseAfter(() => commands.close());
  fixture.releaseAfter(async () => {
    const completed = await completeVerifierRun(verification);
    // Windows command cleanup is verified by the native job owner.
    if (process.platform !== "win32")
      assertVerifierCleanupComplete(completed.process_lineage);
  });
  const exec = (file, args, maxBuffer = 4 * 1024 * 1024) =>
    commands.exec(file, args, { timeout: 15_000, maxBuffer });
  const assertRefusal = (result, message) =>
    assert.rejects(result, (error) => {
      assert.equal(error.name, "VerifierCommandExitError");
      assert.equal(error.code, 1);
      assert.equal(error.snapshot.stdout.text, "");
      assert.match(error.snapshot.stderr.text, message);
      return true;
    });
  const symbolsPath = join(scratch, "source.sym");
  const rawInventoryPath = join(scratch, "functions.json");
  const evidencePath = join(scratch, "evidence.json");
  const invalidSymbolsPath = join(scratch, "invalid-utf8.sym");
  const target = {
    path: join(scratch, "target.elf"),
    sha256: targetSha256,
    format: "elf",
    architecture: "mips",
  };
  const provider = { id: "fixture", name: "Fixture provider", version: "1" };
  const observation = {
    operation: "list_procedures",
    parameters: {},
    result: inventory,
  };
  const evidence = createEvidence(target, provider, observation);
  await writeFile(symbolsPath, legacy);
  await writeFile(rawInventoryPath, JSON.stringify(inventory));
  await writeFile(evidencePath, JSON.stringify(evidence));
  await writeFile(
    invalidSymbolsPath,
    Buffer.concat([
      Buffer.from("08005000 "),
      Buffer.from([0xff]),
      Buffer.from(",0020\n"),
    ]),
  );
  const command = fileURLToPath(
    new URL("./psp-symbol-correlation.mjs", import.meta.url),
  );
  const run = (
    inventoryPath,
    {
      symbols = symbolsPath,
      sha256 = targetSha256,
      extra = [],
      entrypoint = command,
    } = {},
  ) =>
    exec(process.execPath, [
      entrypoint,
      "--symbols",
      symbols,
      "--inventory",
      inventoryPath,
      "--format",
      "sym",
      "--source-base",
      settings.sourceBase,
      "--analysis-base",
      settings.analysisBase,
      "--target-sha256",
      sha256,
      ...extra,
    ]);
  const raw = await run(rawInventoryPath);
  const rawReport = JSON.parse(raw.stdout);
  assert.deepEqual(rawReport.records, report.records);
  assert.deepEqual(
    rawReport.observed_labels_by_address,
    report.observed_labels_by_address,
  );
  assert.deepEqual(rawReport.input_paths, {
    symbols: symbolsPath,
    inventory: rawInventoryPath,
  });
  assert.equal(rawReport.inventory_target_claim, null);
  assert.equal(rawReport.inventory_provenance, "raw-unverified");

  const fromEvidence = await run(evidencePath);
  const evidenceReport = JSON.parse(fromEvidence.stdout);
  assert.deepEqual(evidenceReport.input_paths, {
    symbols: symbolsPath,
    inventory: evidencePath,
  });
  assert.equal(evidenceReport.inventory_target_claim, targetSha256);
  assert.equal(evidenceReport.inventory_provenance, "rea-evidence");
  assert.deepEqual(evidenceReport.records, rawReport.records);

  const invalidEvidencePath = join(scratch, "invalid-evidence.json");
  for (const [record, message] of [
    [
      createEvidence(target, provider, {
        ...observation,
        operation: "list_names",
      }),
      /Evidence inventory must come from list_procedures/u,
    ],
    [
      { ...evidence, evidence_format: 3 },
      /Recreate observations with the current REA release/u,
    ],
    [
      { ...evidence, normalized_result: [] },
      /Evidence semantic identifier does not match/u,
    ],
    [
      createEvidence(unknownTarget("not-observed"), provider, observation),
      /Procedure inventory Evidence must identify a file/u,
    ],
  ]) {
    await writeFile(invalidEvidencePath, JSON.stringify(record));
    await assertRefusal(run(invalidEvidencePath), message);
  }
  await assertRefusal(
    run(evidencePath, { extra: ["--target-sha256", "b".repeat(64)] }),
    /Unknown or repeated flag/u,
  );
  await assertRefusal(
    run(evidencePath, { sha256: "b".repeat(64) }),
    /Inventory target identity disagrees/u,
  );
  await assertRefusal(
    run(rawInventoryPath, { symbols: invalidSymbolsPath }),
    /encoded data|utf-8/iu,
  );

  // A shell pipe has zero stat size. Feed it a finite over-limit input
  // and bound the child so a broken reader cannot hang or exhaust the runner.
  if (process.platform === "linux") {
    const link = join(scratch, "correlate.mjs");
    await symlink(command, link);
    assert.deepEqual(
      JSON.parse((await run(evidencePath, { entrypoint: link })).stdout),
      evidenceReport,
    );

    const pipe = (source, bytes) =>
      exec(
        "bash",
        [
          "-c",
          'set -o pipefail; head -c "$1" /dev/zero | "$2" "$3" --symbols "$4" --inventory "$5" --format sym --source-base "$6" --analysis-base "$7" --target-sha256 "$8"',
          "psp-symbol-fixture",
          String(bytes),
          process.execPath,
          command,
          source === "symbols" ? "/dev/stdin" : symbolsPath,
          source === "inventory" ? "/dev/stdin" : rawInventoryPath,
          settings.sourceBase,
          settings.analysisBase,
          targetSha256,
        ],
        1024 * 1024,
      );

    for (const [source, bytes] of [
      ["symbols", 1024 * 1024 + 1],
      ["inventory", 32 * 1024 * 1024 + 1],
    ]) {
      await assertRefusal(pipe(source, bytes), /Input exceeds size limit/u);
    }
  }
} catch (cause) {
  await withVerifierCleanup(() => {
    throw cause;
  }, [() => fixture.keep("PSP symbol verification failed")]);
}
await fixture.release();
console.log(
  "PSP_SYMBOL_CORRELATION_SOURCE_PASS: formats, address spaces, bounded output, UTF-8, CLI and identity refusals",
);
