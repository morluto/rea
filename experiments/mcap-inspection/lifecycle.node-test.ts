import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recording } from "./fixtures.ts";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

await test("CLI preserves inspection results and primary errors when close fails", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-prototype-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "input.mcap");
  const preload = join(folder, "deny-close.mjs");
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
const close = fs.closeSync;
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
  for (const bytes of [await recording(), Buffer.from("malformed recording")]) {
    writeFileSync(path, bytes);
    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, cli, path],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1, run.stderr);
    const output: unknown = JSON.parse(run.stdout);
    assert.ok(output !== null && typeof output === "object" && "ok" in output);
    assert.equal(output.ok, false);
    assert.ok("cleanup_error" in output && "error" in output);
    assert.match(JSON.stringify(output.cleanup_error), /injected close denial/);
    assert.match(
      JSON.stringify(output),
      bytes.length > 100 ? /"message_count":"2"/ : /"reader_rejected"/,
    );
  }
});

for (const maxReadBytes of [Number.MAX_SAFE_INTEGER, 7]) {
  await test(`CLI rejects final-read mutation and closes on failure with ${maxReadBytes === 7 ? "short" : "normal"} reads`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "mcap-prototype-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const path = join(folder, "input.mcap");
    const preload = join(folder, "read-fault.mjs");
    writeFileSync(
      preload,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
const finalReadStart = Number(process.env.MCAP_TEST_FINAL_READ_START);
const finalReadEnd = Number(process.env.MCAP_TEST_FINAL_READ_END);
const maxReadBytes = Number(process.env.MCAP_TEST_MAX_READ_BYTES);
let target, completedUntil = finalReadStart, closed = false, mutated = false, readAfterMutation = false;
fs.openSync = (...args) => {
  const fd = open(...args);
  if (args[0] === process.argv[2]) target = fd;
  return fd;
};
fs.readSync = (...args) => {
  if (args[0] !== target) return read(...args);
  if (process.env.MCAP_TEST_FAULT === 'read') throw new Error('injected read denial');
  if (mutated) readAfterMutation = true;
  const [fd, buffer, offset, length, position] = args;
  const bytes = read(fd, buffer, offset, Math.min(length, maxReadBytes), position);
  if (position === completedUntil && completedUntil < finalReadEnd) completedUntil += bytes;
  if (!mutated && completedUntil === finalReadEnd) {
    fs.appendFileSync(process.argv[2], 'x');
    mutated = true;
  }
  return bytes;
};
fs.closeSync = (fd) => {
  close(fd);
  if (fd === target) closed = true;
};
process.on('exit', () => {
  if (!closed || readAfterMutation || (process.env.MCAP_TEST_FAULT !== 'read' && !mutated)) {
    process.stderr.write('Lifecycle fault boundary or close was not reached as expected\\n');
    process.exitCode = 9;
  }
});
syncBuiltinESMExports();
`,
    );
    for (const fault of ["read", "mutation", "parse-and-mutation"]) {
      const bytes = await recording();
      const footer = bytes.length - 37;
      const finalReadStart = Number(bytes.readBigUInt64LE(footer + 9)) - 13;
      if (fault === "parse-and-mutation")
        bytes.writeUInt8(
          bytes.readUInt8(bytes.length - 12) ^ 1,
          bytes.length - 12,
        );
      writeFileSync(path, bytes);
      const run = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, cli, path],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MCAP_TEST_FAULT: fault,
            MCAP_TEST_MAX_READ_BYTES: String(maxReadBytes),
            MCAP_TEST_FINAL_READ_START: String(finalReadStart),
            MCAP_TEST_FINAL_READ_END: String(footer),
          },
        },
      );
      assert.equal(run.status, 1, run.stderr);
      const output: unknown = JSON.parse(run.stdout);
      assert.ok(
        output !== null && typeof output === "object" && "error" in output,
      );
      assert.match(
        JSON.stringify(output.error),
        fault === "read"
          ? /"kind":"io"/
          : fault === "mutation"
            ? /"kind":"changed"/
            : /"kind":"reader_rejected"/,
      );
      if (fault !== "read") {
        assert.ok("read_ranges" in output);
        assert.ok(Array.isArray(output.read_ranges));
        assert.deepEqual(output.read_ranges.at(-1), {
          offset: String(finalReadStart),
          byte_length: String(footer - finalReadStart),
          sha256: createHash("sha256")
            .update(bytes.subarray(finalReadStart, footer))
            .digest("hex"),
        });
      }
      if (fault === "parse-and-mutation") {
        assert.ok("file_error" in output);
        assert.match(JSON.stringify(output.file_error), /"kind":"changed"/);
      }
    }
  });
}
