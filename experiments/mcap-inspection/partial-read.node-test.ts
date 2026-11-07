import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recording } from "./fixtures.ts";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

function object(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

for (const fault of ["truncate", "read-error"]) {
  await test(`CLI retains consumed bytes when a partial read ends in ${fault}`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "mcap-partial-evidence-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const path = join(folder, "input.mcap");
    const preload = join(folder, "partial-read.mjs");
    const bytes = await recording();
    const footer = bytes.length - 37;
    const start =
      fault === "truncate" ? 0 : Number(bytes.readBigUInt64LE(footer + 9)) - 13;
    const requested = fault === "truncate" ? 17 : footer - start;
    const completed =
      fault === "truncate"
        ? []
        : [
            { offset: 0, length: 17 },
            { offset: 8, length: 9 + Number(bytes.readBigUInt64LE(9)) },
            { offset: footer, length: 37 },
          ];
    writeFileSync(path, bytes);
    writeFileSync(
      preload,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
const path = process.argv[2];
const start = Number(process.env.MCAP_EVIDENCE_READ_START);
let target, consumed = false, failed = false, closed = false;
fs.openSync = (...args) => {
  const fd = open(...args);
  if (args[0] === path && target === undefined) target = fd;
  return fd;
};
fs.readSync = (...args) => {
  if (args[0] !== target) return read(...args);
  const [fd, buffer, offset, length, position] = args;
  if (position === start && !consumed) {
    const count = read(fd, buffer, offset, Math.min(length, 7), position);
    consumed = count === 7;
    if (process.env.MCAP_EVIDENCE_MODE === 'truncate') fs.truncateSync(path, start + count);
    return count;
  }
  if (consumed && position === start + 7) {
    failed = true;
    if (process.env.MCAP_EVIDENCE_MODE === 'read-error') throw new Error('injected partial read denial');
  }
  return read(...args);
};
fs.closeSync = (fd) => {
  close(fd);
  if (fd === target) closed = true;
};
process.on('exit', () => {
  if (!consumed || !failed || !closed) {
    process.stderr.write('Partial read fault or descriptor cleanup was not reached\\n');
    process.exitCode = 9;
  }
});
syncBuiltinESMExports();
`,
    );
    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, cli, path],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MCAP_EVIDENCE_MODE: fault,
          MCAP_EVIDENCE_READ_START: String(start),
        },
      },
    );
    assert.equal(run.status, 1, run.stderr);
    const output: unknown = JSON.parse(run.stdout);
    object(output);
    object(output.error);
    assert.equal(output.error.kind, fault === "truncate" ? "changed" : "io");
    assert.equal(output.cleanup_error, null);
    assert.deepEqual(output.read_ranges, [
      ...completed.map(({ offset, length }) => ({
        offset: String(offset),
        byte_length: String(length),
        sha256: createHash("sha256")
          .update(bytes.subarray(offset, offset + length))
          .digest("hex"),
      })),
      {
        offset: String(start),
        byte_length: "7",
        sha256: createHash("sha256")
          .update(bytes.subarray(start, start + 7))
          .digest("hex"),
        requested_byte_length: String(requested),
        complete: false,
      },
    ]);
  });
}
