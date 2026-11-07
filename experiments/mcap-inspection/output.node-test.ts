import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TempBuffer } from "@mcap/core";
import { recording } from "./fixtures.ts";
import { inspectSummary } from "./summary.ts";
import { OUTPUT_BYTES } from "./limits.ts";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

await test("final output overflow preserves source, ranges and cleanup failure", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-output-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "input.mcap");
  const baseline = await inspectSummary(
    new TempBuffer(await recording({}, undefined, "")),
  );
  if (!baseline.ok) throw baseline.error;
  const length =
    OUTPUT_BYTES - 100 - Buffer.byteLength(JSON.stringify(baseline.value));
  const bytes = await recording({}, undefined, "A".repeat(length));
  const result = await inspectSummary(new TempBuffer(bytes));
  if (!result.ok) throw result.error;
  writeFileSync(path, bytes);
  const preload = join(folder, "deny-close.mjs");
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, close = fs.closeSync;
let target;
fs.openSync = (...args) => {
  const fd = open(...args);
  if (args[0] === process.argv[2]) target = fd;
  return fd;
};
fs.closeSync = (fd) => {
  if (fd === target) throw new Error('injected close denial');
  return close(fd);
};
syncBuiltinESMExports();
`,
  );
  for (const args of [[], ["--import", pathToFileURL(preload).href]]) {
    const run = spawnSync(process.execPath, [...args, cli, path], {
      encoding: "utf8",
      maxBuffer: 2 * OUTPUT_BYTES,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr, "");
    assert.ok(Buffer.byteLength(run.stdout.trimEnd()) <= OUTPUT_BYTES);
    const output: unknown = JSON.parse(run.stdout);
    assert.ok(output !== null && typeof output === "object");
    assert.ok(
      "source" in output && "read_ranges" in output && "output_error" in output,
    );
    assert.match(JSON.stringify(output.source), /input\.mcap/);
    assert.deepEqual(output.read_ranges, result.value.read_ranges);
    assert.match(JSON.stringify(output.output_error), /"kind":"limit"/);
    if (args.length > 0) {
      assert.ok("cleanup_error" in output);
      assert.match(
        JSON.stringify(output.cleanup_error),
        /injected close denial/,
      );
    }
  }
});

await test("large reader diagnostics keep their reason and provenance within the output budget", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-output-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "unindexed.mcap");
  writeFileSync(
    path,
    await recording(
      {
        useChunks: false,
        useStatistics: false,
        useSummaryOffsets: false,
        repeatChannels: false,
        repeatSchemas: false,
      },
      undefined,
      "A".repeat(OUTPUT_BYTES + 1),
    ),
  );
  const run = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  const output: unknown = JSON.parse(run.stdout);
  assert.ok(output !== null && typeof output === "object");
  assert.ok("source" in output && "read_ranges" in output && "error" in output);
  assert.match(JSON.stringify(output.error), /not indexed/);
  assert.match(JSON.stringify(output.error), /message_sha256/);
  assert.match(JSON.stringify(output.source), /unindexed\.mcap/);
  assert.ok(
    Array.isArray(output.read_ranges) && output.read_ranges.length === 3,
  );
});
