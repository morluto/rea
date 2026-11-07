import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admissionPreload } from "./admission-fixture.ts";
import { recording } from "./fixtures.ts";
import { OUTPUT_BYTES } from "./limits.ts";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

function object(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

await test("CLI retains admission and cleanup evidence when request provenance must be omitted", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-admission-limit-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const input = "input.mcap",
    path = join(folder, input);
  writeFileSync(path, await recording());
  const named = lstatSync(path, { bigint: true });
  const empty = JSON.stringify({ arguments: [input], positionals: [input] });
  const count = Math.floor(
    (OUTPUT_BYTES - 512 - Buffer.byteLength(empty)) / 13,
  );
  const args = [input, ...Array.from({ length: count }, () => "--schema=1")];
  const requestJson = JSON.stringify({ arguments: args, positionals: [input] });
  const preload = join(folder, "large-admission.mjs");
  writeFileSync(
    preload,
    `${admissionPreload}\nprocess.argv.push(...Array.from({length:${count}}, () => '--schema=1'));`,
  );
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, cli, input],
    {
      cwd: folder,
      encoding: "utf8",
      maxBuffer: 2 * OUTPUT_BYTES,
      env: {
        ...process.env,
        MCAP_ADMISSION_MODE: "descriptor-and-close-error",
      },
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
  assert.equal(output.source.input, input);
  assert.equal(output.source.path, path);
  object(output.source.admission);
  const admission = output.source.admission;
  object(admission.path);
  object(admission.path.state);
  assert.equal(admission.path.state.inode, String(named.ino));
  assert.deepEqual(admission.open, { status: "opened" });
  object(admission.descriptor);
  assert.equal(admission.descriptor.status, "failed");
  assert.deepEqual(admission.descriptor.error, output.error);
  object(output.error);
  assert.match(
    String(output.error.message),
    /injected admission descriptor denial/,
  );
  object(output.cleanup_error);
  assert.match(
    String(output.cleanup_error.message),
    /injected admission close denial/,
  );
  assert.deepEqual(output.read_ranges, []);
  object(output.output_error);
  assert.equal(output.output_error.kind, "limit");
});

for (const mode of [
  "directory",
  "missing",
  "open-error",
  "descriptor-error",
  "path-replaced",
  "descriptor-and-close-error",
] as const) {
  await test(`CLI preserves admission observations after ${mode}`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "mcap-admission-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const input = mode === "directory" ? "." : "input.mcap";
    const path = mode === "directory" ? folder : join(folder, input);
    const preload = join(folder, "admission.mjs");
    writeFileSync(preload, admissionPreload);
    if (mode !== "directory" && mode !== "missing")
      writeFileSync(path, await recording());
    const named = mode === "missing" ? null : lstatSync(path, { bigint: true });
    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, cli, input],
      {
        cwd: folder,
        encoding: "utf8",
        env: { ...process.env, MCAP_ADMISSION_MODE: mode },
      },
    );
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr, "");
    const output: unknown = JSON.parse(run.stdout);
    object(output);
    assert.equal(output.ok, false);
    assert.deepEqual(output.request, {
      arguments: [input],
      positionals: [input],
    });
    assert.deepEqual(output.read_ranges, []);
    assert.equal(output.file_state, null);
    assert.equal(output.file_error, null);
    object(output.error);
    object(output.source);
    assert.equal(output.source.input, input);
    assert.equal(output.source.path, path);
    assert.equal(output.source.hash_scope, undefined);
    object(output.source.admission);
    const admission = output.source.admission;
    object(admission.path);
    object(admission.open);
    object(admission.descriptor);
    assert.equal(
      admission.matches_path,
      mode === "path-replaced" ? false : null,
    );
    if (named === null) {
      assert.equal(admission.path.status, "failed");
      object(admission.path.error);
      assert.deepEqual(admission.path.error, output.error);
      assert.match(String(output.error.message), /ENOENT/);
    } else {
      assert.equal(admission.path.status, "observed");
      object(admission.path.state);
      assert.equal(admission.path.state.size_bytes, String(named.size));
      assert.equal(admission.path.state.device, String(named.dev));
      assert.equal(admission.path.state.inode, String(named.ino));
      assert.equal(admission.path.state.mode_bits, String(named.mode));
      assert.equal(admission.path.state.modified_ns, String(named.mtimeNs));
      assert.equal(admission.path.state.changed_ns, String(named.ctimeNs));
      assert.equal(
        admission.path.state.file_type,
        mode === "directory" ? "other" : "regular",
      );
    }
    if (mode === "directory" || mode === "missing") {
      assert.deepEqual(admission.open, { status: "not_attempted" });
      assert.deepEqual(admission.descriptor, { status: "not_attempted" });
      assert.equal(
        output.error.kind,
        mode === "directory" ? "input" : "io_or_usage",
      );
    } else if (mode === "open-error") {
      assert.equal(admission.open.status, "failed");
      assert.deepEqual(admission.open.error, output.error);
      assert.deepEqual(admission.descriptor, { status: "not_attempted" });
      assert.match(
        String(output.error.message),
        /injected admission open denial/,
      );
    } else {
      assert.deepEqual(admission.open, { status: "opened" });
      if (mode === "path-replaced") {
        assert.equal(output.error.kind, "changed");
        assert.equal(admission.descriptor.status, "observed");
        object(admission.descriptor.state);
        const replaced = lstatSync(path, { bigint: true });
        assert.equal(admission.descriptor.state.inode, String(replaced.ino));
        assert.equal(admission.descriptor.state.size_bytes, "11");
        assert.notEqual(admission.descriptor.state.inode, String(named?.ino));
      } else {
        assert.equal(admission.descriptor.status, "failed");
        assert.deepEqual(admission.descriptor.error, output.error);
        assert.match(
          String(output.error.message),
          /injected admission descriptor denial/,
        );
      }
    }
    if (mode === "descriptor-and-close-error") {
      object(output.cleanup_error);
      assert.equal(output.cleanup_error.kind, "io");
      assert.match(
        String(output.cleanup_error.message),
        /injected admission close denial/,
      );
    } else assert.equal(output.cleanup_error, null);
  });
}
