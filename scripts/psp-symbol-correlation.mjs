#!/usr/bin/env node
// Read-only, explicit-base correlation of PPSSPP labels with a REA function inventory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEX32 = /^(?:0x)?[0-9a-f]{1,8}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function hex32(value, label) {
  assert.match(value, HEX32, label + " must be a 32-bit hex address");
  return BigInt("0x" + value.replace(/^0x/iu, ""));
}

const addressText = (value) => "0x" + value.toString(16);

/** Parse the two-column legacy .sym export or modern module-relative .ppsym v1. */
export function parsePspSymbols(source, format) {
  assert.ok(format === "sym" || format === "ppsym", "Select sym or ppsym explicitly");
  assert.ok(Buffer.byteLength(source) <= 1024 * 1024, "Symbol file exceeds 1 MiB");
  const entries = [];
  let version = false;
  let crc = null;
  let omittedNonfunctions = 0;
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (format === "ppsym" && !version) {
      assert.equal(line, ".ppsym 1", "Unsupported .ppsym header on line " + (index + 1));
      version = true;
      continue;
    }
    if (format === "ppsym" && crc === null) {
      const match = /^crc\s+([0-9a-f]{1,8})$/iu.exec(line);
      assert.ok(match, "Missing .ppsym CRC on line " + (index + 1));
      crc = hex32(match[1], "CRC");
      continue;
    }
    if (format === "ppsym" && /^(D|L)\s/u.test(line)) {
      omittedNonfunctions++;
      continue;
    }
    const match = format === "sym"
      ? /^([0-9a-f]{1,8})\s+([^,\s]+),([0-9a-f]{1,8})$/iu.exec(line)
      : /^F\s+([0-9a-f]{1,8})\s+([0-9a-f]{1,8})\s+(.+)$/iu.exec(line);
    assert.ok(match, "Invalid " + format + " function on line " + (index + 1));
    const address = hex32(match[1], "symbol address");
    const name = format === "sym" ? match[2] : match[3].trim();
    const size = hex32(format === "sym" ? match[3] : match[2], "symbol size");
    assert.ok(name.length > 0, "Empty symbol name on line " + (index + 1));
    entries.push({ line: index + 1, address, size, name });
    assert.ok(entries.length <= 8192, "Too many PSP function labels");
  }
  if (format === "ppsym") assert.ok(version && crc !== null, "Incomplete .ppsym file");
  return { entries, crc, omittedNonfunctions };
}

/** Check observed names at explicitly mapped addresses, never infer equivalence. */
export function correlatePspSymbols(source, inventory, options) {
  const { format, sourceBase, analysisBase, targetSha256, expectedCrc = null } = options;
  assert.match(targetSha256, SHA256, "Provide the exact selected target SHA-256");
  assert.ok(Array.isArray(inventory) && inventory.length <= 50000, "Invalid function inventory");
  const sourceStart = format === "ppsym" ? 0n : hex32(sourceBase, "source base");
  const analysisStart = hex32(analysisBase, "Ghidra analysis base");
  const parsed = parsePspSymbols(source, format);
  if (expectedCrc !== null) {
    const expected = hex32(expectedCrc, "expected module CRC");
    assert.ok(format === "ppsym", "CRC applies only to .ppsym");
    if (parsed.crc !== 0n) assert.equal(parsed.crc, expected, "Module CRC does not match");
  }
  const observed = new Map();
  for (const row of inventory) {
    assert.ok(row !== null && typeof row === "object" &&
      typeof row.address === "string" && typeof row.value === "string", "Invalid Ghidra inventory row");
    const key = addressText(hex32(row.address, "Ghidra function address"));
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push(row.value);
  }
  const mapped = parsed.entries.map((entry) => {
    const relative = entry.address - sourceStart;
    const addr = analysisStart + relative;
    const address = relative < 0n || addr > 0xffffffffn ? null : addressText(addr);
    return { ...entry, analysisAddress: address };
  });
  const duplicates = new Map();
  for (const entry of mapped) {
    if (entry.analysisAddress !== null)
      duplicates.set(entry.analysisAddress, (duplicates.get(entry.analysisAddress) ?? 0) + 1);
  }
  const records = mapped.map(({ line, address: sourceAddress, analysisAddress, name, size }) => {
    const names = analysisAddress === null ? [] : (observed.get(analysisAddress) ?? []);
    let outcome;
    if (analysisAddress === null) outcome = "outside_selected_mapping";
    else if ((duplicates.get(analysisAddress) ?? 0) > 1 || names.length > 1) outcome = "ambiguous";
    else if (name.startsWith("z_un_")) outcome = "generated_placeholder";
    else if (names.length === 0) outcome = "not_observed";
    else outcome = names[0] === name ? "address_and_label_agree" : "address_only";
    return {
      line,
      source_address: addressText(sourceAddress),
      analysis_address: analysisAddress,
      label: name,
      declared_size: addressText(size),
      observed_labels: names,
      outcome,
    };
  });
  return {
    format,
    source_sha256: createHash("sha256").update(source).digest("hex"),
    target_sha256: targetSha256,
    selected_bases: { source: addressText(sourceStart), analysis: addressText(analysisStart) },
    module_crc: parsed.crc === null ? null : addressText(parsed.crc),
    crc_checked: format === "ppsym" && parsed.crc !== 0n && expectedCrc !== null,
    ignored_nonfunction_records: parsed.omittedNonfunctions,
    records,
    limitation: "Address/name agreement in the supplied inventory is not target or module identity proof; the caller must authenticate and select the matching executable, module and load base. Missing functions and differing names remain unresolved.",
  };
}

async function readBounded(path, maxBytes) {
  assert.ok((await stat(path)).size <= maxBytes, "Input exceeds size limit: " + path);
  return readFile(path, "utf8");
}

async function main(args) {
  const flags = new Map();
  const supported = new Set([
    "--symbols", "--inventory", "--format", "--source-base",
    "--analysis-base", "--target-sha256", "--expected-crc",
  ]);
  assert.equal(args.length % 2, 0, "Flags require values");
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(supported.has(args[i]) && !flags.has(args[i]), "Unknown or repeated flag " + args[i]);
    flags.set(args[i], args[i + 1]);
  }
  for (const required of ["--symbols", "--inventory", "--format", "--analysis-base", "--target-sha256"])
    assert.ok(flags.get(required), "Missing " + required);
  if (flags.get("--format") === "sym") assert.ok(flags.get("--source-base"), "Legacy .sym requires --source-base");
  if (flags.get("--format") === "ppsym") assert.ok(!flags.has("--source-base"), "Modern .ppsym offsets are module-relative");
  const source = await readBounded(flags.get("--symbols"), 1024 * 1024);
  const data = JSON.parse(await readBounded(flags.get("--inventory"), 32 * 1024 * 1024));
  const inventory = Array.isArray(data) ? data : data.normalized_result;
  const claimedHash = data?.subject?.digest?.sha256;
  if (claimedHash !== undefined) assert.equal(claimedHash, flags.get("--target-sha256"), "Inventory target identity disagrees");
  const report = correlatePspSymbols(source, inventory, {
    format: flags.get("--format"),
    sourceBase: flags.get("--source-base"),
    analysisBase: flags.get("--analysis-base"),
    targetSha256: flags.get("--target-sha256"),
    expectedCrc: flags.get("--expected-crc") ?? null,
  });
  process.stdout.write(JSON.stringify({
    ...report,
    input_paths: {
      symbols: flags.get("--symbols"),
      inventory: flags.get("--inventory"),
    },
    inventory_target_claim: claimedHash ?? null,
  }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write("PSP symbol correlation failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
