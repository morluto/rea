import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recording } from "./fixtures.ts";
import { OUTPUT_BYTES } from "./limits.ts";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

function object(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

for (const [name, args] of [
  ["options before target", ["--schema", "1", "recording.mcap"]],
  ["inline schema value", ["recording.mcap", "--schema=1"]],
  ["option terminator", ["--", "--sensor.mcap"]],
] as const) {
  await test(`CLI preserves request parsing with ${name}`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "mcap-request-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const input =
      name === "option terminator" ? "--sensor.mcap" : "recording.mcap";
    writeFileSync(join(folder, input), await recording());
    const run = spawnSync(process.execPath, [cli, ...args], {
      cwd: folder,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const output: unknown = JSON.parse(run.stdout);
    object(output);
    assert.equal(output.ok, true);
    object(output.source);
    assert.equal(output.source.input, input);
    assert.deepEqual(output.request, { arguments: args, positionals: [input] });
  });
}

for (const [name, args, positionals] of [
  ["ambiguous schema value", ["--schema", "--unknown"], []],
  ["missing schema value", ["--schema"], []],
  [
    "unknown option before target",
    ["--unknown", "recording.mcap"],
    ["recording.mcap"],
  ],
] as const) {
  await test(`CLI retains arguments without admitting a target for ${name}`, () => {
    const run = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1, run.stderr);
    const output: unknown = JSON.parse(run.stdout);
    object(output);
    assert.equal(output.ok, false);
    object(output.source);
    assert.equal(output.source.input, positionals[0] ?? null);
    assert.deepEqual(output.request, { arguments: args, positionals });
    assert.deepEqual(output.read_ranges, []);
    assert.equal(output.file_state, null);
  });
}

await test("CLI rejects an unreportable request before target I/O and retains its exact JSON digest", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-request-limit-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const input = '"\u0001\\\ud800'.repeat(70_000);
  const requestJson = JSON.stringify({
    arguments: [input],
    positionals: [input],
  });
  assert.ok(Buffer.byteLength(requestJson) > OUTPUT_BYTES);
  const preload = join(folder, "oversized-request.mjs");
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const input = ${JSON.stringify(input)};
const target = resolve(input), open = fs.openSync, lstat = fs.lstatSync;
process.argv.splice(2, process.argv.length, input);
let targetAccessed = false;
fs.openSync = (...args) => {
  if (args[0] === target || args[0] === input) {
    targetAccessed = true;
    throw new Error('unreportable request attempted target open');
  }
  return open(...args);
};
fs.lstatSync = (...args) => {
  if (args[0] === target || args[0] === input) {
    targetAccessed = true;
    throw new Error('unreportable request attempted target metadata');
  }
  return lstat(...args);
};
process.on('exit', () => {
  if (targetAccessed) {
    process.stderr.write('Unreportable request reached target I/O\\n');
    process.exitCode = 9;
  }
});
syncBuiltinESMExports();
`,
  );
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, cli],
    {
      encoding: "utf8",
      maxBuffer: 2 * OUTPUT_BYTES,
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "");
  assert.ok(Buffer.byteLength(run.stdout.trimEnd()) <= OUTPUT_BYTES);
  const output: unknown = JSON.parse(run.stdout);
  object(output);
  assert.equal(output.ok, false);
  assert.deepEqual(output.request, {
    omitted: "json_limit",
    json_bytes: Buffer.byteLength(requestJson),
    sha256: createHash("sha256").update(requestJson).digest("hex"),
  });
  assert.deepEqual(output.source, { input: null, input_omitted: "json_limit" });
  object(output.error);
  assert.equal(output.error.kind, "limit");
  assert.deepEqual(output.read_ranges, []);
  assert.equal(output.file_state, null);
});

await test("CLI preserves file evidence when final receipts require request omission", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-receipt-limit-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "input.mcap");
  const bytes = await recording();
  writeFileSync(path, bytes);
  const empty = JSON.stringify({ arguments: [path], positionals: [path] });
  const count = Math.floor(
    (OUTPUT_BYTES - 1024 - Buffer.byteLength(empty)) / 13,
  );
  const args = [path, ...Array.from({ length: count }, () => "--schema=1")];
  const requestJson = JSON.stringify({ arguments: args, positionals: [path] });
  const preload = join(folder, "large-request.mjs");
  writeFileSync(
    preload,
    `process.argv.push(...Array.from({length:${count}}, () => "--schema=1"));`,
  );
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, cli, path],
    {
      encoding: "utf8",
      maxBuffer: 2 * OUTPUT_BYTES,
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "");
  assert.ok(Buffer.byteLength(run.stdout.trimEnd()) <= OUTPUT_BYTES);
  const output: unknown = JSON.parse(run.stdout);
  object(output);
  assert.equal(output.ok, false);
  assert.deepEqual(output.request, {
    omitted: "json_limit",
    json_bytes: Buffer.byteLength(requestJson),
    sha256: createHash("sha256").update(requestJson).digest("hex"),
  });
  object(output.source);
  assert.equal(output.source.input, path);
  object(output.file_state);
  object(output.file_state.descriptor);
  object(output.file_state.path);
  assert.equal(output.file_state.descriptor.matches_initial, true);
  assert.equal(output.file_state.path.matches_initial, true);
  assert.equal(output.error, null);
  assert.equal(output.cleanup_error, null);
  object(output.output_error);
  assert.equal(output.output_error.kind, "limit");
  assert.ok(Array.isArray(output.read_ranges));
  assert.equal(output.read_ranges.length, 4);
  for (const range of output.read_ranges) {
    object(range);
    const start = Number(range.offset),
      length = Number(range.byte_length);
    assert.equal(
      range.sha256,
      createHash("sha256")
        .update(bytes.subarray(start, start + length))
        .digest("hex"),
    );
  }
});
