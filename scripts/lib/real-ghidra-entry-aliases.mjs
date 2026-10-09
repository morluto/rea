import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Verify imported entry aliases through CLI/MCP without admitting interior labels. */
export async function verifyGhidraEntryAliases({
  call,
  reject,
  target,
  entrypoint,
  env,
}) {
  const exec = promisify(execFile);
  const compiler = process.env.REA_CC ?? "cc";
  const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-entry-aliases-"));
  const source = fileURLToPath(
    new URL("../../tests/conformance/ghidra/entry-aliases.c", import.meta.url),
  );
  const path = join(workspace, "entry-aliases");
  const prefix = process.platform === "darwin" ? "_" : "";
  try {
    await exec(compiler, ["-O0", "-g", "-fno-inline", source, "-o", path], {
      env,
      timeout: 30000,
    });
    const bytes = await readFile(path);
    await call("close_binary");
    await call("open_binary", { path, provider_id: "ghidra" });
    const names = await call("list_names");
    const alias = names.find(
      ({ value }) => value === `${prefix}rea_entry_alias`,
    );
    assert.ok(alias, "Fixture entry alias was not imported");
    assert.equal(
      alias.symbol.primary,
      false,
      "The regression must exercise a secondary entry symbol",
    );
    assert.equal(alias.symbol.source, "imported");
    const canonical = (await call("list_procedures")).find(
      ({ address }) => address === alias.address,
    );
    assert.ok(canonical, "Fixture alias is not at a function entry");
    for (const procedure of [
      alias.value,
      "dead",
      canonical.value,
      alias.address,
    ]) {
      assert.equal(
        await call("procedure_address", { procedure }),
        alias.address,
      );
      assert.equal(
        (await call("analyze_function", { procedure })).procedure.address,
        alias.address,
      );
      assert.equal(
        await call("procedure_pseudo_code", { procedure }),
        await call("procedure_pseudo_code", { procedure: alias.address }),
      );
    }
    // Leaf and qualified forms of the primary name must not duplicate a match.
    assert.equal(
      (await call("procedure_info", { procedure: alias.value })).entrypoint,
      alias.address,
    );
    const interior = names.find(
      ({ value }) => value === `${prefix}rea_interior`,
    );
    assert.ok(interior);
    assert.notEqual(interior.address, alias.address);
    const failure = await reject("procedure_address", {
      procedure: interior.value,
    });
    assert.equal(failure.code, "invalid_request");
    assert.match(
      JSON.stringify(failure.details.issues),
      /Unknown Ghidra procedure name or address/u,
    );
    assert.equal(
      await call("procedure_address", { procedure: interior.address }),
      alias.address,
      "Explicit interior addresses keep their existing containment semantics",
    );
    const edited = await call("annotate_native_function", {
      procedure: alias.value,
      comment: "Selected by imported entry alias",
    });
    assert.equal(edited.annotations.address, alias.address);
    assert.equal(
      edited.annotations.comment,
      "Selected by imported entry alias",
    );
    assert.equal(
      await call("procedure_address", { procedure: alias.value }),
      alias.address,
    );
    await call("close_binary");
    const { stdout } = await exec(
      process.execPath,
      [
        entrypoint,
        "function",
        path,
        alias.value,
        "--provider",
        "ghidra",
        "--json",
      ],
      { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(
      JSON.parse(stdout).normalized_result.procedure.address,
      alias.address,
    );
    assert.deepEqual(await readFile(path), bytes);
    await call("open_binary", { path: target.path, provider_id: "ghidra" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
