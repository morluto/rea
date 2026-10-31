import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

for (const [name, args, positionals] of [
  ["unknown option", ["recording.mcap", "--unknown"], ["recording.mcap"]],
  ["missing schema value", ["recording.mcap", "--schema"], ["recording.mcap"]],
  [
    "excess positional",
    ["recording.mcap", "second.mcap"],
    ["recording.mcap", "second.mcap"],
  ],
] as const) {
  await test(`CLI retains the request when rejecting ${name}`, () => {
    const run = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1, run.stderr);
    const output: unknown = JSON.parse(run.stdout);
    object(output);
    object(output.source);
    assert.equal(output.source.input, positionals[0]);
    assert.deepEqual(output.request, { arguments: args, positionals });
    assert.deepEqual(output.read_ranges, []);
  });
}

const finalStatePreload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
const stat = fs.fstatSync, lstat = fs.lstatSync;
const path = process.argv[2], mode = process.env.MCAP_EVIDENCE_MODE;
const start = Number(process.env.MCAP_EVIDENCE_FINAL_START);
const end = Number(process.env.MCAP_EVIDENCE_FINAL_END);
let target, reached = start, finished = false, closed = false;
fs.openSync = (...args) => {
  const fd = open(...args);
  if (args[0] === path && target === undefined) target = fd;
  return fd;
};
fs.readSync = (...args) => {
  const count = read(...args);
  if (args[0] === target && args[4] === reached && reached < end) {
    reached += count;
    if (reached === end) {
      finished = true;
      if (mode === 'metadata-change') fs.appendFileSync(path, 'x');
      if (mode === 'path-replaced') {
        fs.renameSync(path, path + '.old');
        fs.writeFileSync(path, 'replacement');
      }
      if (mode === 'path-missing') fs.unlinkSync(path);
    }
  }
  return count;
};
fs.fstatSync = (...args) => {
  if (finished && args[0] === target && mode === 'descriptor-error')
    throw new Error('injected descriptor metadata denial');
  return stat(...args);
};
fs.lstatSync = (...args) => {
  if (finished && args[0] === path && mode === 'path-error')
    throw new Error('injected pathname metadata denial');
  return lstat(...args);
};
fs.closeSync = (fd) => {
  close(fd);
  if (fd === target) closed = true;
};
process.on('exit', () => {
  if (!finished || !closed) {
    process.stderr.write('Final range or descriptor cleanup was not reached\\n');
    process.exitCode = 9;
  }
});
syncBuiltinESMExports();
`;

for (const mode of [
  "metadata-change",
  "descriptor-error",
  "path-replaced",
  "path-missing",
  "path-error",
]) {
  await test(`CLI retains both final file observations after ${mode}`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "mcap-evidence-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const path = join(folder, "input.mcap");
    const preload = join(folder, "final-state.mjs");
    const bytes = await recording();
    const footer = bytes.length - 37;
    const start = Number(bytes.readBigUInt64LE(footer + 9)) - 13;
    writeFileSync(path, bytes);
    writeFileSync(preload, finalStatePreload);
    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, cli, path],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MCAP_EVIDENCE_MODE: mode,
          MCAP_EVIDENCE_FINAL_START: String(start),
          MCAP_EVIDENCE_FINAL_END: String(footer),
        },
      },
    );
    assert.equal(run.status, 1, run.stderr);
    const output: unknown = JSON.parse(run.stdout);
    object(output);
    assert.equal(output.cleanup_error, null);
    object(output.source);
    object(output.file_state);
    object(output.file_state.descriptor);
    object(output.file_state.path);
    const descriptor = output.file_state.descriptor;
    const named = output.file_state.path;
    if (mode === "descriptor-error") {
      assert.equal(descriptor.state, null);
      assert.equal(descriptor.matches_initial, null);
      object(descriptor.error);
      assert.match(
        String(descriptor.error.message),
        /injected descriptor metadata denial/,
      );
      assert.equal(named.matches_initial, true);
    } else {
      object(descriptor.state);
      assert.equal(descriptor.state.inode, output.source.inode);
      assert.equal(descriptor.error, null);
    }
    if (mode === "path-error" || mode === "path-missing") {
      assert.equal(named.state, null);
      assert.equal(named.matches_initial, null);
      object(named.error);
      assert.match(
        String(named.error.message),
        mode === "path-error" ? /injected pathname metadata denial/ : /ENOENT/,
      );
    } else {
      object(named.state);
      assert.equal(named.error, null);
      if (mode === "metadata-change") {
        assert.equal(named.state.size_bytes, String(bytes.length + 1));
        assert.equal(descriptor.matches_initial, false);
        assert.equal(named.matches_initial, false);
      }
      if (mode === "path-replaced") {
        assert.notEqual(named.state.inode, output.source.inode);
        assert.equal(named.state.size_bytes, "11");
        assert.equal(named.matches_initial, false);
      }
    }
  });
}
